import { test, expect } from "@playwright/test";
import {
  applyLayoutOverride,
  clampBox,
  denormalizeBox,
  effectiveStickMode,
  emptyLayoutOverride,
  gestureBox,
  hasLayoutEdits,
  layoutModeForOrientation,
  layoutStorageKey,
  MIN_CONTROL_SIZE,
  moveBox,
  normalizeBox,
  parseLayoutOverride,
  scaleBox,
  setControlBox,
  alignmentLines,
  snapBox,
  SNAP_PX,
  isStickModeToggleable,
  toggleStickMode,
  type ControlBox,
  type LayoutOverride,
} from "@kapula/phone/utils";
import { resolveLayout, type Viewport } from "@kapula/phone/utils";
import { GENERIC_GAMEPAD_SCHEMA, type GamepadControl } from "@kapula/protocol";

const LANDSCAPE: Viewport = { width: 844, height: 390 };
const PORTRAIT: Viewport = { width: 390, height: 844 };

const box = (x: number, y: number, width: number, height = width): ControlBox => ({
  x,
  y,
  width,
  height,
});

const expectInside = (b: ControlBox, viewport: Viewport) => {
  expect(b.x - b.width / 2).toBeGreaterThanOrEqual(-1e-9);
  expect(b.y - b.height / 2).toBeGreaterThanOrEqual(-1e-9);
  expect(b.x + b.width / 2).toBeLessThanOrEqual(viewport.width + 1e-9);
  expect(b.y + b.height / 2).toBeLessThanOrEqual(viewport.height + 1e-9);
};

test.describe("stored boxes", () => {
  test("normalize and denormalize round-trip in the same viewport", () => {
    const original = box(700, 300, 120, 60);
    const back = denormalizeBox(normalizeBox(original, LANDSCAPE), LANDSCAPE);
    expect(back.x).toBeCloseTo(original.x);
    expect(back.y).toBeCloseTo(original.y);
    expect(back.width).toBeCloseTo(original.width);
    expect(back.height).toBeCloseTo(original.height);
  });

  test("sizes follow the shorter side, so a circle stays a circle when the box changes shape", () => {
    const stored = normalizeBox(box(100, 300, 120), LANDSCAPE);
    // Same phone, browser chrome gone: a taller box. Position scales with the
    // box, size with the shorter side — still 120 px, still round.
    const taller = denormalizeBox(stored, { width: 844, height: 420 });
    expect(taller.width).toBeCloseTo(120 * (420 / 390));
    expect(taller.height).toBeCloseTo(taller.width);
    expect(taller.x).toBeCloseTo(100);
  });
});

test.describe("clampBox", () => {
  test("keeps a box that fits untouched", () => {
    expect(clampBox(box(200, 200, 100), LANDSCAPE)).toEqual(box(200, 200, 100));
  });

  test("pulls an off-screen box back inside without resizing it", () => {
    const clamped = clampBox(box(-50, 1000, 100), LANDSCAPE);
    expect(clamped).toEqual(box(50, 340, 100));
    expectInside(clamped, LANDSCAPE);
  });

  test("enforces the minimum size uniformly", () => {
    const clamped = clampBox(box(200, 200, 10, 5), LANDSCAPE);
    expect(clamped.height).toBe(MIN_CONTROL_SIZE);
    expect(clamped.width).toBe(MIN_CONTROL_SIZE * 2);
  });

  test("shrinks an oversized box to the viewport, keeping its aspect ratio", () => {
    const clamped = clampBox(box(400, 200, 2000, 1000), LANDSCAPE);
    expect(clamped.width).toBeCloseTo(780);
    expect(clamped.height).toBeCloseTo(390);
    expectInside(clamped, LANDSCAPE);
  });

  test("a viewport smaller than a fingertip still keeps the box on-screen", () => {
    const tiny = { width: 20, height: 20 };
    const clamped = clampBox(box(10, 10, 100), tiny);
    expect(clamped.width).toBe(20);
    expectInside(clamped, tiny);
  });
});

test.describe("move and scale", () => {
  test("moveBox translates and clamps", () => {
    expect(moveBox(box(100, 100, 50), 20, -30, LANDSCAPE)).toEqual(box(120, 70, 50));
    expect(moveBox(box(100, 100, 50), -500, 0, LANDSCAPE).x).toBe(25);
  });

  test("scaleBox scales about the center and clamps", () => {
    const bigger = scaleBox(box(100, 100, 50), 2, LANDSCAPE);
    expect(bigger).toEqual(box(100, 100, 100));
    const smaller = scaleBox(box(100, 100, 50), 0.1, LANDSCAPE);
    expect(smaller.width).toBe(MIN_CONTROL_SIZE);
    // Growing at the edge pushes the box inward instead of off-screen.
    const edge = scaleBox(box(25, 25, 50), 4, LANDSCAPE);
    expect(edge.width).toBe(200);
    expect(edge.x).toBe(100);
    expect(edge.y).toBe(100);
  });
});

test.describe("gestureBox", () => {
  const start = box(300, 200, 100);

  test("one pointer drags by its movement", () => {
    const moved = gestureBox(start, [{ x: 10, y: 10 }], [{ x: 40, y: -5 }], 0);
    expect(moved).toEqual(box(330, 185, 100));
  });

  test("the drag is mapped through the surface's synthetic rotation", () => {
    // Content rotated 90° (notch-left landscape on a portrait viewport): a
    // finger moving down the physical screen moves the box to the right.
    const moved = gestureBox(start, [{ x: 0, y: 0 }], [{ x: 0, y: 50 }], 90);
    expect(moved.x).toBeCloseTo(350);
    expect(moved.y).toBeCloseTo(200);
  });

  test("two pointers pinch: spread ratio scales, centroid movement drags", () => {
    const from = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    const to = [
      { x: 60, y: 110 },
      { x: 260, y: 110 },
    ];
    const pinched = gestureBox(start, from, to, 0);
    expect(pinched.width).toBeCloseTo(200);
    expect(pinched.height).toBeCloseTo(200);
    expect(pinched.x).toBeCloseTo(310);
    expect(pinched.y).toBeCloseTo(210);
  });

  test("a pinch's scale does not depend on the rotation", () => {
    const from = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ];
    const to = [
      { x: 0, y: 0 },
      { x: 0, y: 50 },
    ];
    for (const synthetic of [0, 90, 180, 270] as const) {
      expect(gestureBox(start, from, to, synthetic).width).toBeCloseTo(50);
    }
  });

  test("no pointers or a degenerate spread leave the box alone", () => {
    expect(gestureBox(start, [], [], 0)).toEqual(start);
    const same = { x: 5, y: 5 };
    expect(gestureBox(start, [same, same], [same, same], 0)).toEqual(start);
  });
});

test.describe("overrides on top of the engine's layout", () => {
  const layout = resolveLayout(GENERIC_GAMEPAD_SCHEMA, LANDSCAPE);
  const stickBefore = layout.controls.find((c) => c.control.id === "stick")!;

  test("setControlBox records a clamped, normalized box and keeps the mode", () => {
    const override = setControlBox(null, "landscape", "a", box(-10, 50, 80), LANDSCAPE);
    expect(override.mode).toBe("landscape");
    expect(hasLayoutEdits(override)).toBe(true);
    const back = denormalizeBox(override.controls.a, LANDSCAPE);
    expect(back.x).toBeCloseTo(40);
    expect(back.width).toBeCloseTo(80);
  });

  test("an override of the other mode is dropped when a control is set", () => {
    const portrait = setControlBox(null, "one-hand", "a", box(100, 100, 80), PORTRAIT);
    const landscape = setControlBox(portrait, "landscape", "b", box(100, 100, 80), LANDSCAPE);
    expect(Object.keys(landscape.controls)).toEqual(["b"]);
  });

  test("only the edited controls move; roles are kept", () => {
    const override = setControlBox(null, "landscape", "a", box(400, 100, 90), LANDSCAPE);
    const applied = applyLayoutOverride(layout, override, LANDSCAPE);
    const a = applied.controls.find((c) => c.control.id === "a")!;
    expect(a.x).toBeCloseTo(400);
    expect(a.y).toBeCloseTo(100);
    expect(a.width).toBeCloseTo(90);
    expect(a.role).toBe("primary");
    expect(applied.controls.find((c) => c.control.id === "stick")).toEqual(stickBefore);
  });

  test("a stored box is clamped into the viewport it is applied to", () => {
    const override: LayoutOverride = {
      ...emptyLayoutOverride("landscape"),
      controls: { a: { cx: 1.5, cy: -2, w: 0.2, h: 0.2 } },
    };
    const a = applyLayoutOverride(layout, override, LANDSCAPE).controls.find(
      (c) => c.control.id === "a",
    )!;
    expectInside(a, LANDSCAPE);
  });

  test("an override for the other layout mode, or a null one, is ignored whole", () => {
    const override = setControlBox(null, "one-hand", "a", box(100, 100, 90), PORTRAIT);
    expect(applyLayoutOverride(layout, override, LANDSCAPE)).toBe(layout);
    expect(applyLayoutOverride(layout, null, LANDSCAPE)).toBe(layout);
  });

  test("entries for controls the schema no longer has are ignored", () => {
    const override = setControlBox(null, "landscape", "gone", box(100, 100, 90), LANDSCAPE);
    const applied = applyLayoutOverride(layout, override, LANDSCAPE);
    expect(applied.controls).toHaveLength(layout.controls.length);
    expect(applied.controls.map((c) => c.control.id)).toEqual(
      layout.controls.map((c) => c.control.id),
    );
  });
});

test.describe("storage shape", () => {
  test("keys are namespaced by driver app, schema and mode", () => {
    expect(layoutStorageKey("uuid-1", "tank", "landscape")).toBe(
      "gamepad:layout:uuid-1:tank:landscape",
    );
    expect(layoutStorageKey("uuid-1", "tank", "one-hand")).not.toBe(
      layoutStorageKey("uuid-1", "tank", "landscape"),
    );
  });

  test("the layout mode follows the surface's orientation", () => {
    expect(layoutModeForOrientation("landscape")).toBe("landscape");
    expect(layoutModeForOrientation("portrait")).toBe("one-hand");
  });

  test("parseLayoutOverride accepts what was saved and drops garbage entries", () => {
    const saved = setControlBox(null, "landscape", "a", box(100, 100, 90), LANDSCAPE);
    const parsed = parseLayoutOverride(JSON.parse(JSON.stringify(saved)));
    expect(parsed).toEqual(saved);
    const dirty = parseLayoutOverride({
      version: 1,
      mode: "one-hand",
      controls: {
        ok: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2 },
        nan: { cx: Number.NaN, cy: 0.5, w: 0.2, h: 0.2 },
        flat: { cx: 0.5, cy: 0.5, w: 0, h: 0.2 },
        partial: { cx: 0.5 },
        nothing: null,
      },
    });
    expect(dirty?.mode).toBe("one-hand");
    expect(Object.keys(dirty?.controls ?? {})).toEqual(["ok"]);
  });

  test("parseLayoutOverride rejects unknown versions, modes and shapes", () => {
    expect(parseLayoutOverride(null)).toBeNull();
    expect(parseLayoutOverride("x")).toBeNull();
    expect(parseLayoutOverride({ version: 2, mode: "landscape", controls: {} })).toBeNull();
    expect(parseLayoutOverride({ version: 1, mode: "sideways", controls: {} })).toBeNull();
    expect(parseLayoutOverride({ version: 1, mode: "landscape" })).toBeNull();
  });

  test("hasLayoutEdits is false for null and empty overrides", () => {
    expect(hasLayoutEdits(null)).toBe(false);
    expect(hasLayoutEdits(emptyLayoutOverride("landscape"))).toBe(false);
  });
});

/**
 * A player may swap a stick between "full" and "relative" — both report
 * `{x, y}`, so the driver never sees the difference — but never into a mode
 * that changes the wire shape.
 */
test.describe("stick mode swapping", () => {
  // Typed as the control union: spreading a narrowed element would leave
  // the other members' fields in the spread type.
  const full: GamepadControl = GENERIC_GAMEPAD_SCHEMA.controls.find((c) => c.id === "stick")!;
  const relative: GamepadControl = { ...(full as Extract<GamepadControl, { type: "joystick" }>), mode: "relative" };
  const xOnly: GamepadControl = { ...(full as Extract<GamepadControl, { type: "joystick" }>), mode: "x" };
  const button = GENERIC_GAMEPAD_SCHEMA.controls.find((c) => c.id === "a")!;
  const layout = resolveLayout(GENERIC_GAMEPAD_SCHEMA, LANDSCAPE);

  test("only full and relative sticks are toggleable", () => {
    expect(isStickModeToggleable(full)).toBe(true);
    expect(isStickModeToggleable(relative)).toBe(true);
    expect(isStickModeToggleable(xOnly)).toBe(false);
    expect(isStickModeToggleable(button)).toBe(false);
    expect(toggleStickMode(null, "landscape", xOnly)).toBeNull();
    expect(toggleStickMode(null, "landscape", button)).toBeNull();
  });

  test("toggling records the departure and toggling back drops it", () => {
    const swapped = toggleStickMode(null, "landscape", full)!;
    expect(swapped.sticks).toEqual({ stick: "relative" });
    expect(hasLayoutEdits(swapped)).toBe(true);
    expect(effectiveStickMode(swapped, full)).toBe("relative");
    const back = toggleStickMode(swapped, "landscape", full)!;
    expect(back.sticks).toEqual({});
    expect(hasLayoutEdits(back)).toBe(false);
    expect(effectiveStickMode(back, full)).toBe("full");
    // A relative stick swaps the other way.
    expect(toggleStickMode(null, "landscape", relative)!.sticks).toEqual({
      stick: "full",
    });
    expect(effectiveStickMode(null, xOnly)).toBeNull();
  });

  test("applying an override swaps the resolved control's mode and keeps its box", () => {
    const swapped = toggleStickMode(null, "landscape", full);
    const applied = applyLayoutOverride(layout, swapped, LANDSCAPE);
    const stick = applied.controls.find((c) => c.control.id === "stick")!;
    const before = layout.controls.find((c) => c.control.id === "stick")!;
    expect(stick.control).toEqual({ ...full, mode: "relative" });
    expect({ x: stick.x, y: stick.y, width: stick.width, height: stick.height }).toEqual(
      { x: before.x, y: before.y, width: before.width, height: before.height },
    );
  });

  test("a stored stick mode is ignored for a control that is no longer toggleable", () => {
    const override: LayoutOverride = {
      ...emptyLayoutOverride("landscape"),
      sticks: { stick: "relative" },
    };
    const xSchema = { ...GENERIC_GAMEPAD_SCHEMA, controls: [xOnly, button] };
    const applied = applyLayoutOverride(resolveLayout(xSchema, LANDSCAPE), override, LANDSCAPE);
    const stick = applied.controls.find((c) => c.control.id === "stick")!.control;
    expect(stick.type === "joystick" ? stick.mode : null).toBe("x");
  });

  test("box edits and stick modes coexist, and moves keep the modes", () => {
    const swapped = toggleStickMode(null, "landscape", full);
    const moved = setControlBox(swapped, "landscape", "stick", box(100, 100, 90), LANDSCAPE);
    expect(moved.sticks).toEqual({ stick: "relative" });
    expect(Object.keys(moved.controls)).toEqual(["stick"]);
    const toggledAgain = toggleStickMode(moved, "landscape", full)!;
    expect(Object.keys(toggledAgain.controls)).toEqual(["stick"]);
  });

  test("parseLayoutOverride reads stick modes and tolerates their absence", () => {
    const saved = toggleStickMode(null, "landscape", full);
    expect(parseLayoutOverride(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const legacy = parseLayoutOverride({ version: 1, mode: "landscape", controls: {} });
    expect(legacy?.sticks).toEqual({});
    const dirty = parseLayoutOverride({
      version: 1,
      mode: "landscape",
      controls: {},
      sticks: { ok: "relative", bad: "dpad", worse: 3 },
    });
    expect(dirty?.sticks).toEqual({ ok: "relative" });
  });
});

test.describe("snapping while dragging", () => {
  const others = [box(200, 100, 80), box(600, 300, 80)];
  const lines = alignmentLines(others, LANDSCAPE);

  test("the lines are the neighbours' centers plus the screen's middle", () => {
    expect(lines.x).toEqual([LANDSCAPE.width / 2, 200, 600]);
    expect(lines.y).toEqual([LANDSCAPE.height / 2, 100, 300]);
  });

  test("a near miss sticks; a clear miss does not", () => {
    const near = snapBox(box(200 + SNAP_PX - 1, 250, 80), lines);
    expect(near.box.x).toBe(200);
    expect(near.guides.x).toEqual([200]);

    const far = snapBox(box(200 + SNAP_PX + 1, 250, 80), lines);
    expect(far.box.x).toBe(200 + SNAP_PX + 1);
    expect(far.guides.x).toEqual([]);
  });

  test("the axes are independent", () => {
    // Lined up with one neighbour across and a different one down.
    const snapped = snapBox(box(198, 302, 80), lines);
    expect(snapped.box).toMatchObject({ x: 200, y: 300 });
    expect(snapped.guides).toEqual({ x: [200], y: [300] });

    const onlyY = snapBox(box(400, 98, 80), lines);
    expect(onlyY.box.x).toBe(400);
    expect(onlyY.box.y).toBe(100);
    expect(onlyY.guides).toEqual({ x: [], y: [100] });
  });

  test("the nearest line wins, and ties keep the first", () => {
    const crowded = { x: [100, 108], y: [] as number[] };
    expect(snapBox(box(106, 0, 80), crowded).box.x).toBe(108);
    // Exactly between two: the first stays chosen, so a jittering finger
    // does not flip the control back and forth.
    expect(snapBox(box(104, 0, 80), crowded).box.x).toBe(100);
  });

  test("only the center moves — never the size", () => {
    const original = box(203, 97, 120, 60);
    const snapped = snapBox(original, lines);
    expect(snapped.box.width).toBe(original.width);
    expect(snapped.box.height).toBe(original.height);
    expect(snapped.box).toMatchObject({ x: 200, y: 100 });
  });

  test("a snapped box still clamps into the viewport", () => {
    // A line can sit under the edge; clamping afterwards is what keeps the
    // control on-screen (the editor always clamps what snapBox returns).
    const edge = alignmentLines([box(2, 2, 40)], LANDSCAPE);
    const snapped = snapBox(box(4, 4, 200), edge);
    expect(snapped.box).toMatchObject({ x: 2, y: 2 });
    expectInside(clampBox(snapped.box, LANDSCAPE), LANDSCAPE);
  });

  test("with nothing near, the box passes through untouched", () => {
    const alone = alignmentLines([], { width: 800, height: 400 });
    const original = box(123, 321, 50);
    const snapped = snapBox(original, alone);
    expect(snapped.box).toEqual(original);
    expect(snapped.guides).toEqual({ x: [], y: [] });
  });
});
