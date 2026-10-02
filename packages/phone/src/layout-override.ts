import type { GamepadControl } from "@kapula/protocol";
import type { ScreenAngle } from "./gyro-utils.js";
import type { ResolvedLayout, Viewport } from "./layout-utils.js";
import { rotateDelta, type ContentOrientation } from "./orientation-utils.js";

/**
 * Player-edited controller layouts, the pure part: what is stored, how a
 * stored box maps onto a viewport, and the drag / pinch arithmetic the
 * layout editor runs. Kept free of React and the DOM (unit-tested).
 *
 * The layout engine in layout-utils.ts stays the first draft: it places
 * every control for the schema, and an override replaces the geometry of the
 * controls the player moved or resized — the others keep flowing through the
 * engine. Boxes are stored relative to the viewport (center as fractions of
 * its width/height, sizes as fractions of its shorter side) so an edit made
 * in a browser tab still fits the same phone installed to the home screen,
 * where the box is a few dozen pixels different, and a stick edited on one
 * phone stays a circle on another. Every box is clamped into the viewport
 * when applied, so a stored layout can never hide a control off-screen.
 *
 * Besides geometry, a player can swap a stick between the two modes that
 * report the same thing — `"full"` (fixed center, springs back) and
 * `"relative"` (neutral wherever the thumb lands) — since that is a matter
 * of feel the driver cannot know; both send `{x, y}`, so the driver never
 * sees the difference. Other modes change the wire shape and stay as the
 * driver declared them.
 */

export type LayoutMode = ResolvedLayout["mode"];

/** A control's box: center in px from the container's top-left, plus size. */
export type ControlBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** A box relative to a viewport — see the module comment. */
export type StoredBox = { cx: number; cy: number; w: number; h: number };

export const LAYOUT_OVERRIDE_VERSION = 1;

/** The two stick modes a player may swap between (same wire shape). */
export type StickMode = "full" | "relative";

export type LayoutOverride = {
  version: typeof LAYOUT_OVERRIDE_VERSION;
  /** Landscape and one-hand layouts are different drafts, edited apart. */
  mode: LayoutMode;
  controls: Record<string, StoredBox>;
  /** Sticks the player switched away from the driver's mode. */
  sticks: Record<string, StickMode>;
};

/** No control is ever shrunk below a fingertip. */
export const MIN_CONTROL_SIZE = 36;

/** What the editor's "smaller" / "bigger" buttons scale by per tap. */
export const SIZE_STEP = 1.15;

/**
 * localStorage key of one edited layout. Namespaced by the driver's
 * `driverAppUuid`, so a game's layouts survive across its sessions without
 * leaking into another game that happens to reuse a schema id.
 */
export const layoutStorageKey = (
  driverAppUuid: string,
  schemaId: string,
  mode: LayoutMode,
): string => `gamepad:layout:${driverAppUuid}:${schemaId}:${mode}`;

/** The layout mode the engine picks on an oriented surface of this orientation. */
export const layoutModeForOrientation = (
  orientation: ContentOrientation,
): LayoutMode => (orientation === "portrait" ? "one-hand" : "landscape");

export const emptyLayoutOverride = (mode: LayoutMode): LayoutOverride => ({
  version: LAYOUT_OVERRIDE_VERSION,
  mode,
  controls: {},
  sticks: {},
});

export const hasLayoutEdits = (override: LayoutOverride | null): boolean =>
  override !== null &&
  (Object.keys(override.controls).length > 0 ||
    Object.keys(override.sticks).length > 0);

/** Whether the player may swap this control between full and relative. */
export const isStickModeToggleable = (
  control: GamepadControl,
): control is GamepadControl & { type: "joystick"; mode: StickMode } =>
  control.type === "joystick" &&
  (control.mode === "full" || control.mode === "relative");

/** The mode a stick plays in: the player's choice, else the driver's. */
export const effectiveStickMode = (
  override: LayoutOverride | null,
  control: GamepadControl,
): StickMode | null => {
  if (!isStickModeToggleable(control)) return null;
  return override?.sticks[control.id] ?? control.mode;
};

/**
 * Flips a stick between full and relative. Choosing the driver's own mode
 * again drops the entry rather than storing it, so an override only ever
 * records departures from the schema.
 */
export const toggleStickMode = (
  override: LayoutOverride | null,
  mode: LayoutMode,
  control: GamepadControl,
): LayoutOverride | null => {
  if (!isStickModeToggleable(control)) return override;
  const base =
    override && override.mode === mode ? override : emptyLayoutOverride(mode);
  const current = base.sticks[control.id] ?? control.mode;
  const next: StickMode = current === "full" ? "relative" : "full";
  const sticks = { ...base.sticks };
  if (next === control.mode) delete sticks[control.id];
  else sticks[control.id] = next;
  return { ...base, sticks };
};

const shorterSide = ({ width, height }: Viewport) => Math.min(width, height);

export const normalizeBox = (box: ControlBox, viewport: Viewport): StoredBox => {
  const s = shorterSide(viewport);
  return {
    cx: box.x / viewport.width,
    cy: box.y / viewport.height,
    w: box.width / s,
    h: box.height / s,
  };
};

export const denormalizeBox = (
  stored: StoredBox,
  viewport: Viewport,
): ControlBox => {
  const s = shorterSide(viewport);
  return {
    x: stored.cx * viewport.width,
    y: stored.cy * viewport.height,
    width: stored.w * s,
    height: stored.h * s,
  };
};

/**
 * Fits a box into the viewport: scaled uniformly (so a circle stays a
 * circle) up to the minimum size and down to what fits, then its center is
 * clamped so the whole box is on-screen. Fitting wins over the minimum when
 * the viewport is smaller than a fingertip — nothing is ever off-screen.
 */
export const clampBox = (box: ControlBox, viewport: Viewport): ControlBox => {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  let scale = Math.max(1, MIN_CONTROL_SIZE / Math.min(width, height));
  scale = Math.min(scale, viewport.width / width, viewport.height / height);
  const w = width * scale;
  const h = height * scale;
  return {
    x: w >= viewport.width ? viewport.width / 2 : clamp(box.x, w / 2, viewport.width - w / 2),
    y: h >= viewport.height ? viewport.height / 2 : clamp(box.y, h / 2, viewport.height - h / 2),
    width: w,
    height: h,
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const moveBox = (
  box: ControlBox,
  dx: number,
  dy: number,
  viewport: Viewport,
): ControlBox => clampBox({ ...box, x: box.x + dx, y: box.y + dy }, viewport);

/** Uniform scale about the box's center. */
export const scaleBox = (
  box: ControlBox,
  factor: number,
  viewport: Viewport,
): ControlBox =>
  clampBox(
    { ...box, width: box.width * factor, height: box.height * factor },
    viewport,
  );

export type Point = { x: number; y: number };

/**
 * The box a drag / pinch gesture has turned `start` into: pointers moved
 * from `from` to `to` (same order, same count) in client coordinates. The
 * centroid's movement drags the box — mapped through the oriented surface's
 * synthetic rotation, so the box follows the finger however the phone is
 * turned — and, with two or more pointers, the change in their spread scales
 * it (distances are rotation-invariant). Unclamped: the caller fits the
 * result with `clampBox`.
 */
export const gestureBox = (
  start: ControlBox,
  from: Point[],
  to: Point[],
  synthetic: ScreenAngle,
): ControlBox => {
  const n = Math.min(from.length, to.length);
  if (n === 0) return start;
  const centroid = (points: Point[]) => ({
    x: points.slice(0, n).reduce((sum, p) => sum + p.x, 0) / n,
    y: points.slice(0, n).reduce((sum, p) => sum + p.y, 0) / n,
  });
  const a = centroid(from);
  const b = centroid(to);
  const delta = rotateDelta(b.x - a.x, b.y - a.y, synthetic);
  let factor = 1;
  if (n >= 2) {
    const spreadFrom = Math.hypot(from[0].x - from[1].x, from[0].y - from[1].y);
    const spreadTo = Math.hypot(to[0].x - to[1].x, to[0].y - to[1].y);
    if (spreadFrom > 0 && spreadTo > 0) factor = spreadTo / spreadFrom;
  }
  return {
    x: start.x + delta.dx,
    y: start.y + delta.dy,
    width: start.width * factor,
    height: start.height * factor,
  };
};

/**
 * How close (px) a dragged control's center must come to an alignment line
 * before it sticks to it. A thumb places a control to within a few pixels of
 * where it means to; this is the width of "meant to line them up".
 */
export const SNAP_PX = 10;

/** Candidate alignment lines, in container coordinates. */
export type SnapLines = { x: number[]; y: number[] };

/**
 * What a dragged control may line up with: the center of every other
 * control (thumb rows and button columns are the point of the exercise) and
 * the viewport's two center lines.
 */
export const alignmentLines = (
  others: ControlBox[],
  viewport: Viewport,
): SnapLines => ({
  x: [viewport.width / 2, ...others.map((box) => box.x)],
  y: [viewport.height / 2, ...others.map((box) => box.y)],
});

const nearestLine = (value: number, lines: number[], threshold: number) => {
  let best: number | null = null;
  let bestDistance = threshold;
  for (const line of lines) {
    const distance = Math.abs(line - value);
    // `<` keeps the first of equally close lines, so the result is stable
    // while a finger jitters between two of them.
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Sticks a box's center to the nearest alignment line on each axis, and
 * reports the lines it snapped to so the editor can draw them. The axes are
 * independent: a control can line up with one neighbour horizontally and a
 * different one vertically.
 *
 * Only the center moves — never the size — so snapping can never shrink a
 * control below the minimum or push it off-screen; the caller still clamps.
 */
export const snapBox = (
  box: ControlBox,
  lines: SnapLines,
  threshold = SNAP_PX,
): { box: ControlBox; guides: SnapLines } => {
  const x = nearestLine(box.x, lines.x, threshold);
  const y = nearestLine(box.y, lines.y, threshold);
  return {
    box: { ...box, x: x ?? box.x, y: y ?? box.y },
    guides: { x: x === null ? [] : [x], y: y === null ? [] : [y] },
  };
};

/** Records a control's box (in this viewport) in the override. */
export const setControlBox = (
  override: LayoutOverride | null,
  mode: LayoutMode,
  controlId: string,
  box: ControlBox,
  viewport: Viewport,
): LayoutOverride => {
  const base =
    override && override.mode === mode ? override : emptyLayoutOverride(mode);
  return {
    ...base,
    controls: {
      ...base.controls,
      [controlId]: normalizeBox(clampBox(box, viewport), viewport),
    },
  };
};

/**
 * The engine's layout with the player's edits on top. Only controls the
 * schema still has are affected (a stale entry for a control the driver
 * removed is ignored), roles are kept (they drive the button styling), and
 * an override of the other layout mode is ignored whole.
 */
export const applyLayoutOverride = (
  layout: ResolvedLayout,
  override: LayoutOverride | null,
  viewport: Viewport,
): ResolvedLayout => {
  if (!override || override.mode !== layout.mode) return layout;
  return {
    mode: layout.mode,
    controls: layout.controls.map((resolved) => {
      let next = resolved;
      const stored = override.controls[resolved.control.id];
      if (stored) {
        next = { ...next, ...clampBox(denormalizeBox(stored, viewport), viewport) };
      }
      const stickMode = override.sticks[resolved.control.id];
      if (
        stickMode &&
        isStickModeToggleable(resolved.control) &&
        stickMode !== resolved.control.mode
      ) {
        next = { ...next, control: { ...resolved.control, mode: stickMode } };
      }
      return next;
    }),
  };
};

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Validates a stored (or otherwise untrusted) override; null when unusable. */
export const parseLayoutOverride = (raw: unknown): LayoutOverride | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<LayoutOverride>;
  if (candidate.version !== LAYOUT_OVERRIDE_VERSION) return null;
  if (candidate.mode !== "landscape" && candidate.mode !== "one-hand") return null;
  if (!candidate.controls || typeof candidate.controls !== "object") return null;
  const controls: Record<string, StoredBox> = {};
  for (const [id, box] of Object.entries(candidate.controls)) {
    const b = box as Partial<StoredBox> | null;
    if (
      !b ||
      !isFiniteNumber(b.cx) ||
      !isFiniteNumber(b.cy) ||
      !isFiniteNumber(b.w) ||
      !isFiniteNumber(b.h) ||
      b.w <= 0 ||
      b.h <= 0
    ) {
      continue;
    }
    controls[id] = { cx: b.cx, cy: b.cy, w: b.w, h: b.h };
  }
  const sticks: Record<string, StickMode> = {};
  // Absent in layouts saved before stick modes were editable.
  if (candidate.sticks && typeof candidate.sticks === "object") {
    for (const [id, stickMode] of Object.entries(candidate.sticks)) {
      if (stickMode === "full" || stickMode === "relative") {
        sticks[id] = stickMode;
      }
    }
  }
  return {
    version: LAYOUT_OVERRIDE_VERSION,
    mode: candidate.mode,
    controls,
    sticks,
  };
};
