import type {
  ControlSchema,
  KapulaControl,
  KapulaControlZone,
  KapulaDpadDirection,
  KapulaGyroControl,
  KapulaMotionControl,
  KapulaRawControl,
} from "@kapula/protocol";

/**
 * Pure controller-layout engine: assigns every control of a schema to an
 * ergonomic thumb zone and returns pixel geometry for a given viewport.
 * Kept free of React and the DOM so unit tests can assert real geometry
 * (bounds, overlaps) directly.
 *
 * Three inputs decide where a control goes (see KAPULA.md):
 * - Optional driver positions: per-control `x` / `y`, the center as a
 *   percentage of the viewport's width / height. These are exact — applied
 *   after the draft below, per axis, and only clamped so the box stays
 *   on-screen. Sizes still come from the draft (zone + `size`), and a
 *   positioned control still takes its slot in the draft's flow, so a
 *   driver positioning some controls exactly should position all of them.
 * - Optional driver hints: per-control `zone` ("left" | "right" |
 *   "shoulder-left" | "shoulder-right" | "aux") and `size` ("small" |
 *   "medium" | "large"), plus per-schema `orientation`. Hints state intent —
 *   the engine still owns all geometry, so a hint can never push a control
 *   off-screen or onto another one.
 * - Array order = importance, for everything without a zone hint:
 *   - Joysticks: 1st bottom-left, 2nd bottom-right, 3rd/4th small in the
 *     upper corners; any more shrink into a center row (degenerate but
 *     on-screen).
 *   - Buttons: the first four form a diamond under the right thumb, the next
 *     four become shoulder pills along the top edge (alternating left/right),
 *     the rest a small aux row top-center.
 *
 * Zone overflow rules: a thumb diamond holds four buttons — further "left" /
 * "right" buttons spill to that side's shoulder row. A "left" / "right"
 * joystick takes that side's bottom corner, then the small upper corner, then
 * the center row; "shoulder-*" joysticks go straight to the upper corner and
 * "aux" ones to the center row. The upper corner on a side is only available
 * while that side has no button diamond (the diamond occupies that space).
 */

export type Viewport = { width: number; height: number };

export type ControlRole = "stick" | "primary" | "shoulder" | "aux";

export type ResolvedControl = {
  control: KapulaControl;
  role: ControlRole;
  /** Center of the control in px from the container's top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ResolvedLayout = {
  mode: "landscape" | "one-hand";
  controls: ResolvedControl[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Sectors counter-clockwise from screen-right in 45° steps (y is down).
const DPAD_SECTORS: readonly KapulaDpadDirection[] = [
  "r",
  "dr",
  "d",
  "dl",
  "l",
  "ul",
  "u",
  "ur",
];

/** How much of the pad radius counts as the released center. */
export const DPAD_DEADZONE = 0.3;

/**
 * Maps a pointer offset from the pad center (px, y down) to one of the 9
 * dpad states: centered ("c") inside the dead zone, otherwise the nearest
 * of 8 directions in 45° sectors.
 */
export const pointToDpadDirection = (
  dx: number,
  dy: number,
  radius: number,
): KapulaDpadDirection => {
  if (Math.hypot(dx, dy) < radius * DPAD_DEADZONE) return "c";
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const sector = Math.round(((degrees + 360) % 360) / 45) % 8;
  return DPAD_SECTORS[sector];
};

/**
 * A relative pad's full-deflection travel, as a fraction of the pad's shorter
 * side (with a floor, so a shrunken pad stays usable). The finger may land
 * anywhere in the pad and drag out of it, so the throw cannot depend on where
 * the touch landed: it is a fixed radius around that point, sized to feel
 * like a normal stick's throw.
 */
export const RELATIVE_STICK_TRAVEL = 0.35;

export const relativeStickTravel = (width: number, height: number): number =>
  Math.max(24, Math.min(width, height) * RELATIVE_STICK_TRAVEL);

/**
 * A relative pad's value: the drag from the touch-down origin (px, y down),
 * clamped to a circle of `travel` px. Returns the normalized axes the driver
 * receives together with the clamped px offset the knob is drawn at, so the
 * knob can never show a deflection that was not sent.
 */
export const relativeStickValue = (
  dx: number,
  dy: number,
  travel: number,
): { x: number; y: number; dx: number; dy: number } => {
  if (!(travel > 0)) return { x: 0, y: 0, dx: 0, dy: 0 };
  const distance = Math.hypot(dx, dy);
  const scale = distance > travel ? travel / distance : 1;
  const clampedX = dx * scale;
  const clampedY = dy * scale;
  return {
    x: clampedX / travel,
    y: clampedY / travel,
    dx: clampedX,
    dy: clampedY,
  };
};

/** The `size` hint scales a control relative to its zone's default. */
const SIZE_FACTOR = { small: 0.8, medium: 1, large: 1.2 } as const;

/**
 * Controls the engine does not place: sensors (tilt, raw motion) have no
 * footprint, and a `raw` touch surface is the whole box rather than a slot in
 * it (the Controller draws it). None of them take hints.
 */
const isSensor = (
  control: KapulaControl,
): control is KapulaGyroControl | KapulaMotionControl | KapulaRawControl =>
  control.type === "gyro" || control.type === "motion" || control.type === "raw";

const sizeFactor = (control: KapulaControl): number =>
  isSensor(control) ? 1 : SIZE_FACTOR[control.size ?? "medium"];

const zoneOf = (control: KapulaControl): KapulaControlZone | undefined =>
  isSensor(control) ? undefined : control.zone;

/**
 * Controls the engine places in stick slots: joysticks, and touchpads, which
 * are a stick's size and belong under a thumb just the same.
 */
const isStickLike = (control: KapulaControl): boolean =>
  control.type === "joystick" || control.type === "touchpad";

/**
 * Controls the engine places as buttons: buttons, and `text` controls,
 * which are a button that opens the keyboard.
 */
const isButtonLike = (control: KapulaControl): boolean =>
  control.type === "button" || control.type === "text";

/** A touchpad is drawn bigger than a stick of the same slot and hint. */
const TOUCHPAD_SCALE = 1.3;

const stickScale = (control: KapulaControl): number =>
  sizeFactor(control) * (control.type === "touchpad" ? TOUCHPAD_SCALE : 1);

export type OrientationLock = "landscape" | "portrait" | null;

/**
 * Which way the phone must be held for this schema: the driver's
 * `orientation` hint wins; "auto" falls back to the control-count heuristic
 * (two sticks or more than four buttons need two thumbs). `null` means the
 * schema works either way.
 */
export const orientationLock = (schema: ControlSchema): OrientationLock => {
  if (schema.orientation === "landscape") return "landscape";
  if (schema.orientation === "portrait") return "portrait";
  const sticks = schema.controls.filter(isStickLike).length;
  const buttons = schema.controls.filter(isButtonLike).length;
  return sticks >= 2 || buttons > 4 ? "landscape" : null;
};

/** Big schemas need two thumbs; small ones also work one-handed in portrait. */
export const needsLandscape = (schema: ControlSchema): boolean =>
  orientationLock(schema) === "landscape";

/**
 * Single-axis sticks render as pill tracks along their axis (never smaller
 * than a thumb); full sticks, relative pads and dpads take the whole d×d box.
 * A touchpad keeps its declared aspect: d is its height, unless the width
 * that makes would pass `maxWidth` — then the width is capped and the
 * height follows, so the aspect is never bent.
 */
const stickDims = (
  control: KapulaControl,
  d: number,
  maxWidth: number,
): { width: number; height: number } => {
  if (control.type === "touchpad") {
    const aspect = control.aspect ?? 1;
    const width = Math.min(d * aspect, Math.max(1, maxWidth));
    return { width, height: width / aspect };
  }
  const mode = control.type === "joystick" ? control.mode : "full";
  if (mode === "x") return { width: d, height: Math.max(48, d * 0.5) };
  if (mode === "y") return { width: Math.max(48, d * 0.5), height: d };
  return { width: d, height: d };
};

export const resolveLayout = (
  schema: ControlSchema,
  viewport: Viewport,
): ResolvedLayout => {
  const lock = orientationLock(schema);
  const oneHand =
    lock === "portrait" ||
    (lock === null && viewport.height > viewport.width);
  const draft = oneHand
    ? oneHandLayout(schema, viewport)
    : landscapeLayout(schema, viewport);
  return applyDriverPositions(draft, viewport);
};

/**
 * Whether the player may edit this schema's layout: not when the driver
 * locked it (`disallowLayoutCustomization`), and not when nothing is laid
 * out — a schema of only a `raw` surface and sensors has nothing to move or
 * resize.
 */
export const canCustomizeLayout = (
  config: { disallowLayoutCustomization: boolean },
  schema: ControlSchema,
): boolean =>
  !config.disallowLayoutCustomization &&
  schema.controls.some((c) => !isSensor(c));

/** Whether the driver pinned this control's center on either axis. */
export const hasDriverPosition = (control: KapulaControl): boolean =>
  !isSensor(control) && (control.x !== undefined || control.y !== undefined);

/**
 * Moves every control the driver positioned (`x` / `y` in percent of the
 * viewport) to that point, axis by axis, keeping the draft's size. The
 * center is then clamped so the whole box stays inside the viewport — a
 * position of 0 or 100 lands the control flush with the edge, never past
 * it. Controls without positions are returned untouched.
 */
export const applyDriverPositions = (
  layout: ResolvedLayout,
  { width: w, height: h }: Viewport,
): ResolvedLayout => {
  if (!layout.controls.some((c) => hasDriverPosition(c.control))) return layout;
  return {
    mode: layout.mode,
    controls: layout.controls.map((resolved) => {
      const { control } = resolved;
      if (isSensor(control)) return resolved;
      const x =
        control.x === undefined
          ? resolved.x
          : clamp((control.x / 100) * w, resolved.width / 2, w - resolved.width / 2);
      const y =
        control.y === undefined
          ? resolved.y
          : clamp((control.y / 100) * h, resolved.height / 2, h - resolved.height / 2);
      return x === resolved.x && y === resolved.y ? resolved : { ...resolved, x, y };
    }),
  };
};

const landscapeLayout = (
  schema: ControlSchema,
  { width: w, height: h }: Viewport,
): ResolvedLayout => {
  const sticks = schema.controls.filter(isStickLike);
  const buttons = schema.controls.filter(isButtonLike);
  const pad = clamp(h * 0.05, 12, 24);
  const gap = clamp(h * 0.04, 10, 16);
  const controls: ResolvedControl[] = [];

  // --- Buttons into clusters: hinted ones claim their zone (with the
  // documented overflow), the rest flow through the array-order heuristic.
  const diamond: Record<"left" | "right", KapulaControl[]> = {
    left: [],
    right: [],
  };
  const shoulders: Record<"left" | "right", KapulaControl[]> = {
    left: [],
    right: [],
  };
  const aux: KapulaControl[] = [];
  const unhinted: KapulaControl[] = [];
  for (const control of buttons) {
    const zone = zoneOf(control);
    if (zone === "left" || zone === "right") {
      const group = diamond[zone];
      (group.length < 4 ? group : shoulders[zone]).push(control);
    } else if (zone === "shoulder-left") shoulders.left.push(control);
    else if (zone === "shoulder-right") shoulders.right.push(control);
    else if (zone === "aux") aux.push(control);
    else unhinted.push(control);
  }
  for (const control of unhinted) {
    if (diamond.right.length < 4) diamond.right.push(control);
    else if (shoulders.left.length + shoulders.right.length < 4)
      (shoulders.left.length <= shoulders.right.length
        ? shoulders.left
        : shoulders.right
      ).push(control);
    else aux.push(control);
  }

  // --- Sticks into slots. The upper corner on a side with a button diamond
  // is off-limits: the diamond sits there (lifted above that side's stick).
  const upperFree = (side: "left" | "right") => diamond[side].length === 0;
  type Slot = "bl" | "br" | "ul" | "ur" | "extra";
  const corner: Partial<Record<"bl" | "br" | "ul" | "ur", KapulaControl>> = {};
  const extraSticks: KapulaControl[] = [];
  const slotPrefs = (control: KapulaControl): Slot[] => {
    switch (zoneOf(control)) {
      case "left":
        return ["bl", "ul", "extra"];
      case "right":
        return ["br", "ur", "extra"];
      case "shoulder-left":
        return ["ul", "extra"];
      case "shoulder-right":
        return ["ur", "extra"];
      case "aux":
        return ["extra"];
      default:
        return upperFree("left")
          ? ["bl", "br", "ul", "ur", "extra"]
          : ["bl", "br", "ur", "ul", "extra"];
    }
  };
  for (const control of sticks) {
    const slot = slotPrefs(control).find(
      (s) =>
        s === "extra" ||
        (!corner[s] &&
          (s === "bl" || s === "br" || upperFree(s === "ul" ? "left" : "right"))),
    )!;
    if (slot === "extra") extraSticks.push(control);
    else corner[slot] = control;
  }

  // --- Shoulder pills along the top edge, from each side's corner inward.
  const shoulderH = clamp(h * 0.12, 32, 44);
  const shoulderBase = clamp(w * 0.11, 64, 96);
  // A "large" pill is a primary action on the index finger (a shoulder fire
  // button), not a modifier: it gets a taller, wider pill than the row.
  const isLargeButton = (control: KapulaControl) =>
    isButtonLike(control) && !isSensor(control) && control.size === "large";
  const pillHeight = (control: KapulaControl) =>
    isLargeButton(control) ? clamp(h * 0.19, 44, 72) : shoulderH;
  let shoulderExtent = pad;
  let topRowsBottom = pad;
  let shoulderBottom = pad;
  for (const side of ["left", "right"] as const) {
    let edge = pad;
    for (const control of shoulders[side]) {
      const bw = clamp(
        shoulderBase * sizeFactor(control) * (isLargeButton(control) ? 1.35 : 1),
        48,
        170,
      );
      const bh = pillHeight(control);
      controls.push({
        control,
        role: "shoulder",
        x: side === "left" ? edge + bw / 2 : w - edge - bw / 2,
        y: pad + bh / 2,
        width: bw,
        height: bh,
      });
      edge += bw + gap;
      shoulderBottom = Math.max(shoulderBottom, pad + bh);
    }
    shoulderExtent = Math.max(shoulderExtent, edge);
  }
  const shoulderCount = shoulders.left.length + shoulders.right.length;
  if (shoulderCount > 0) topRowsBottom = shoulderBottom;

  // Aux pills top-center; drop to a second row when the shoulder pills leave
  // no room beside them.
  if (aux.length > 0) {
    const auxH = 28;
    const auxGap = 8;
    const auxBase = clamp(w * 0.09, 56, 84);
    const widths = aux.map((c) => clamp(auxBase * sizeFactor(c), 44, 110));
    const rowWidth =
      widths.reduce((a, b) => a + b, 0) + (aux.length - 1) * auxGap;
    const firstRowFits =
      shoulderCount === 0 || (w - rowWidth) / 2 >= shoulderExtent + auxGap;
    const y = firstRowFits ? pad + auxH / 2 : topRowsBottom + auxGap + auxH / 2;
    let x = (w - rowWidth) / 2;
    aux.forEach((control, i) => {
      controls.push({
        control,
        role: "aux",
        x: x + widths[i] / 2,
        y,
        width: widths[i],
        height: auxH,
      });
      x += widths[i] + auxGap;
    });
    topRowsBottom = Math.max(topRowsBottom, y + auxH / 2);
  }

  // --- Corner sticks: big in the bottom corners, small in the upper ones.
  const mainBase =
    sticks.length > 1 ? clamp(h * 0.4, 110, 180) : clamp(h * 0.44, 120, 200);
  const smallBase = clamp(h * 0.26, 72, 112);
  const stick = (
    control: KapulaControl,
    x: number,
    y: number,
    d: number,
    maxWidth = w / 2 - pad,
  ): ResolvedControl => ({
    control,
    role: "stick",
    x,
    y,
    ...stickDims(control, d, maxWidth),
  });
  // What a bottom-corner stick is anchored by: its slot (a single-axis pill
  // sits centered in the d×d slot, as it always has), or a touchpad's own
  // box, so a wide or tall pad still sits flush in the corner.
  const cornerDims = (control: KapulaControl, d: number) =>
    control.type === "touchpad"
      ? stickDims(control, d, w / 2 - pad)
      : { width: d, height: d };
  const stickD = (control: KapulaControl, base: number) =>
    clamp(base * stickScale(control), 64, h - 2 * pad);
  let bl: ResolvedControl | undefined;
  let br: ResolvedControl | undefined;
  if (corner.bl) {
    const d = stickD(corner.bl, mainBase);
    const box = cornerDims(corner.bl, d);
    bl = stick(corner.bl, pad + box.width / 2, h - pad - box.height / 2, d);
    controls.push(bl);
  }
  if (corner.br) {
    const d = stickD(corner.br, mainBase);
    const box = cornerDims(corner.br, d);
    br = stick(corner.br, w - pad - box.width / 2, h - pad - box.height / 2, d);
    controls.push(br);
  }
  // A stick's occupied edge is x ± width/2 (a single-axis pill is narrower
  // than its slot), so neighbors anchor on that, not on the slot diameter.
  const leftEdge = bl ? bl.x + bl.width / 2 + gap : pad;
  const rightEdge = br ? br.x - br.width / 2 - gap : w - pad;
  for (const [slot, side] of [
    ["ul", "left"],
    ["ur", "right"],
  ] as const) {
    const control = corner[slot];
    if (!control) continue;
    const d = clamp(smallBase * stickScale(control), 48, h - 2 * pad);
    const y = Math.max(h * 0.42, topRowsBottom + gap + d / 2);
    const half = cornerDims(control, d).width / 2;
    controls.push(
      stick(control, side === "left" ? leftEdge + half : rightEdge - half, y, d),
    );
  }

  // --- Button diamonds: under each hinted thumb — in the corner, or lifted
  // above that side's stick. Both diamonds shrink together when the screen
  // is too narrow for their hinted sizes (hints never cause overlaps).
  // A lone button under a thumb is that thumb's whole job (a fire button):
  // it gets the biggest base - bigger still when no stick shares the thumb -
  // and sits in the corner itself rather than at a diamond's center.
  const primaryBase = (group: KapulaControl[], bottom?: ResolvedControl) =>
    group.length === 1
      ? !bottom && sticks.length <= 1
        ? clamp(h * 0.34, 72, 150)
        : clamp(h * 0.26, 60, 110)
      : group.length <= 2 && !bottom && sticks.length <= 1
        ? clamp(h * 0.24, 56, 100)
        : clamp(h * 0.18, 48, 80);
  const diamondSizes: Record<"left" | "right", number[]> = {
    left: diamond.left.map((c) =>
      clamp(primaryBase(diamond.left, bl) * sizeFactor(c), 36, 160),
    ),
    right: diamond.right.map((c) =>
      clamp(primaryBase(diamond.right, br) * sizeFactor(c), 36, 160),
    ),
  };
  const sidesUsed =
    (diamond.left.length ? 1 : 0) + (diamond.right.length ? 1 : 0);
  // Horizontal room a cluster needs: a lone button its own width, a diamond
  // 2 * (max*0.78 + 4 + max/2) = 2.56*max + 8.
  const clusterNeed = (group: KapulaControl[], max: number) =>
    group.length === 0 ? 0 : group.length === 1 ? max : 2.56 * max + 8;
  if (sidesUsed > 0) {
    const maxL = diamond.left.length ? Math.max(...diamondSizes.left) : 0;
    const maxR = diamond.right.length ? Math.max(...diamondSizes.right) : 0;
    const need = clusterNeed(diamond.left, maxL) + clusterNeed(diamond.right, maxR);
    const fit = rightEdge - leftEdge - (sidesUsed === 2 ? gap : 0);
    if (need > fit) {
      const s = Math.max(0.15, fit / need);
      diamondSizes.left = diamondSizes.left.map((v) => v * s);
      diamondSizes.right = diamondSizes.right.map((v) => v * s);
    }
  }
  const diamondRange: Partial<
    Record<"left" | "right", { left: number; right: number }>
  > = {};
  for (const side of ["left", "right"] as const) {
    const group = diamond[side];
    if (group.length === 0) continue;
    const sizes = diamondSizes[side];
    const max = Math.max(...sizes);
    const spread = max * 0.78 + 4;
    const extent = group.length === 1 ? max / 2 : spread + max / 2;
    const bottom = side === "left" ? bl : br;
    const dcx = side === "right" ? rightEdge - extent : leftEdge + extent;
    const dcy = bottom
      ? clamp(h * 0.48, topRowsBottom + gap + extent, h - pad - extent)
      : h - pad - extent;
    // Slot order: bottom (closest to the resting thumb), right, left, top —
    // matches the A/B/X/Y convention when a driver orders them that way.
    const slots: [number, number][] =
      group.length === 1
        ? [[0, 0]]
        : [
            [0, spread],
            [spread, 0],
            [-spread, 0],
            [0, -spread],
          ];
    group.forEach((control, i) => {
      const [dx, dy] = slots[i];
      controls.push({
        control,
        role: "primary",
        x: dcx + dx,
        y: dcy + dy,
        width: sizes[i],
        height: sizes[i],
      });
    });
    diamondRange[side] = { left: dcx - extent, right: dcx + extent };
  }

  // --- Overflow sticks: a shrunken center row (degenerate but on-screen),
  // kept clear of the diamonds when there is room to dodge them.
  if (extraSticks.length > 0) {
    const n = extraSticks.length;
    let lo = diamondRange.left ? diamondRange.left.right + gap : pad;
    let hi = diamondRange.right ? diamondRange.right.left - gap : w - pad;
    if (hi - lo < n * 32 + (n - 1) * gap) {
      lo = pad;
      hi = w - pad;
    }
    const d = clamp((hi - lo - (n - 1) * gap) / n, 24, smallBase);
    const rowWidth = n * d + (n - 1) * gap;
    extraSticks.forEach((control, i) => {
      controls.push(
        stick(
          control,
          lo + (hi - lo - rowWidth) / 2 + d / 2 + i * (d + gap),
          h * 0.5,
          d,
          d,
        ),
      );
    });
  }

  return { mode: "landscape", controls };
};

/**
 * Portrait layout for one-handed schemas: stick at the bottom center, buttons
 * in rows of two above it (thumb side first), aux-hinted buttons in a small
 * top row. The other zone hints describe two-handed landscape and are
 * ignored here. Also the fallback for orientation:"portrait" schemas of any
 * size, so it must stay total: extra buttons stack into more rows (shrinking
 * to fit) and extra sticks become a small row at the top.
 */
const oneHandLayout = (
  schema: ControlSchema,
  { width: w, height: h }: Viewport,
): ResolvedLayout => {
  const sticks = schema.controls.filter(isStickLike);
  const buttons = schema.controls.filter(isButtonLike);
  const pad = clamp(w * 0.06, 16, 28);
  const gap = clamp(w * 0.05, 12, 24);
  const controls: ResolvedControl[] = [];

  const auxButtons = buttons.filter((c) => zoneOf(c) === "aux");
  const gridButtons = buttons.filter((c) => zoneOf(c) !== "aux");

  let topReserved = pad;
  if (auxButtons.length > 0) {
    const auxH = 28;
    const auxGap = 8;
    const auxBase = clamp(w * 0.16, 56, 84);
    const widths = auxButtons.map((c) =>
      clamp(auxBase * sizeFactor(c), 44, 110),
    );
    const rowWidth =
      widths.reduce((a, b) => a + b, 0) + (auxButtons.length - 1) * auxGap;
    let x = (w - rowWidth) / 2;
    auxButtons.forEach((control, i) => {
      controls.push({
        control,
        role: "aux",
        x: x + widths[i] / 2,
        y: pad + auxH / 2,
        width: widths[i],
        height: auxH,
      });
      x += widths[i] + auxGap;
    });
    topReserved = pad + auxH + gap;
  }

  const stickBase = clamp(w * 0.52, 150, 230);
  let stickTop = h - pad;
  if (sticks.length > 0) {
    const d = clamp(
      stickBase * stickScale(sticks[0]),
      110,
      Math.min(w - 2 * pad, h * 0.42),
    );
    const dims = stickDims(sticks[0], d, w - 2 * pad);
    controls.push({
      control: sticks[0],
      role: "stick",
      x: w / 2,
      y: h - pad - dims.height / 2,
      ...dims,
    });
    stickTop = h - pad - dims.height;
  }

  let gridTop = stickTop;
  if (gridButtons.length > 0) {
    const rows = Math.ceil(gridButtons.length / 2);
    const bGap = clamp(w * 0.06, 12, 24);
    const base = clamp(w * 0.26, 64, 124);
    const maxF = Math.max(...gridButtons.map(sizeFactor));
    // Shrink the grid (gaps included) when many rows must fit between the
    // top rows and the stick — only reachable via an orientation:"portrait"
    // hint on a big schema, a driver bug, but everything must stay on-screen.
    const availH = Math.max(0, stickTop - gap - topReserved);
    const pitch = availH / rows;
    const rowGap = Math.min(bGap, Math.max(4, pitch * 0.2));
    const cell = clamp(Math.min(base * maxF, pitch - rowGap), 12, 120);
    const dx = (cell + rowGap) / 2;
    const rowY = (row: number) =>
      stickTop - gap - cell / 2 - row * (cell + rowGap);
    gridButtons.forEach((control, i) => {
      const size = Math.min(cell, base * sizeFactor(control));
      controls.push({
        control,
        role: "primary",
        x:
          gridButtons.length === 1
            ? w / 2
            : i % 2 === 0
              ? w / 2 + dx
              : w / 2 - dx,
        y: rowY(Math.floor(i / 2)),
        width: size,
        height: size,
      });
    });
    gridTop = rowY(rows - 1) - cell / 2;
  }

  // Extra sticks have no one-handed home; keep them small, above the grid.
  if (sticks.length > 1) {
    const extras = sticks.slice(1);
    const n = extras.length;
    const d = Math.max(
      20,
      Math.min(
        clamp(w * 0.24, 40, 110),
        (w - 2 * pad - (n - 1) * gap) / n,
        gridTop - gap - topReserved,
      ),
    );
    const rowWidth = n * d + (n - 1) * gap;
    const y = Math.max(pad + d / 2, gridTop - gap - d / 2);
    extras.forEach((control, i) => {
      const dims = stickDims(control, d, d);
      controls.push({
        control,
        role: "stick",
        x: (w - rowWidth) / 2 + d / 2 + i * (d + gap),
        y,
        ...dims,
      });
    });
  }

  return { mode: "one-hand", controls };
};
