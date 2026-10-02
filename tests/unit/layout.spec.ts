import { test, expect } from "@playwright/test";
import {
  DPAD_DEADZONE,
  RELATIVE_STICK_TRAVEL,
  applyDriverPositions,
  hasDriverPosition,
  needsLandscape,
  orientationLock,
  pointToDpadDirection,
  relativeStickTravel,
  relativeStickValue,
  resolveLayout,
  type ResolvedControl,
  type Viewport,
} from "@kapula/phone/utils";
import { DEBUG_PRESETS } from "@kapula/phone/utils";
import {
  GENERIC_GAMEPAD_SCHEMA,
  controlSchemaSchema,
  gamepadSessionConfigSchema,
} from "@kapula/protocol";
import type { ControlSchema } from "@kapula/protocol";

const presetSchema = (key: string): ControlSchema => {
  const preset = DEBUG_PRESETS.find((p) => p.key === key)!;
  return gamepadSessionConfigSchema.parse(preset.config).schemas[0];
};

const TANK = presetSchema("tank");
const XBOX = presetSchema("xbox");
const BRAWLER = presetSchema("brawler");
const FIXED = presetSchema("fixed");
const MOUSE = presetSchema("mouse");
const GENERIC = GENERIC_GAMEPAD_SCHEMA;

// Landscape phone viewports, small to large.
const LANDSCAPE_VIEWPORTS: Viewport[] = [
  { width: 568, height: 320 }, // iPhone SE 1
  { width: 640, height: 360 }, // small Android
  { width: 667, height: 375 }, // iPhone SE 2
  { width: 844, height: 390 }, // iPhone 13
  { width: 932, height: 430 }, // large phone
];

// Circles (full sticks, diamond buttons) collide as circles — diamond
// neighbors deliberately overlap as bounding boxes — single-axis pills,
// dpads and shoulder/aux pills collide as rectangles.
const isRound = (c: ResolvedControl) =>
  c.role === "primary" ||
  (c.role === "stick" &&
    c.control.type === "joystick" &&
    c.control.mode === "full");

const overlaps = (a: ResolvedControl, b: ResolvedControl): boolean => {
  if (isRound(a) && isRound(b)) {
    return Math.hypot(a.x - b.x, a.y - b.y) < (a.width + b.width) / 2;
  }
  if (isRound(a) || isRound(b)) {
    const [circle, rect] = isRound(a) ? [a, b] : [b, a];
    const nearestX = Math.max(
      rect.x - rect.width / 2,
      Math.min(circle.x, rect.x + rect.width / 2),
    );
    const nearestY = Math.max(
      rect.y - rect.height / 2,
      Math.min(circle.y, rect.y + rect.height / 2),
    );
    return Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.width / 2;
  }
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2
  );
};

const assertSane = (schema: ControlSchema, viewport: Viewport) => {
  const layout = resolveLayout(schema, viewport);
  expect(layout.controls).toHaveLength(schema.controls.length);
  expect(new Set(layout.controls.map((c) => c.control.id)).size).toBe(
    schema.controls.length,
  );
  for (const c of layout.controls) {
    expect(c.x - c.width / 2, `${c.control.id} left edge`).toBeGreaterThanOrEqual(0);
    expect(c.y - c.height / 2, `${c.control.id} top edge`).toBeGreaterThanOrEqual(0);
    expect(c.x + c.width / 2, `${c.control.id} right edge`).toBeLessThanOrEqual(
      viewport.width,
    );
    expect(c.y + c.height / 2, `${c.control.id} bottom edge`).toBeLessThanOrEqual(
      viewport.height,
    );
  }
  for (let i = 0; i < layout.controls.length; i++) {
    for (let j = i + 1; j < layout.controls.length; j++) {
      const a = layout.controls[i];
      const b = layout.controls[j];
      expect(
        overlaps(a, b),
        `${a.control.id} overlaps ${b.control.id} at ${viewport.width}x${viewport.height}`,
      ).toBe(false);
    }
  }
  return layout;
};

test.describe("needsLandscape", () => {
  test("small schemas work one-handed, big ones demand landscape", () => {
    expect(needsLandscape(GENERIC)).toBe(false); // 1 stick, 2 buttons
    expect(needsLandscape(TANK)).toBe(false); // 1 stick, 2 buttons
    expect(needsLandscape(XBOX)).toBe(true); // 3 sticks, 12 buttons
    expect(
      needsLandscape(
        controlSchemaSchema.parse({
          id: "five",
          name: "Five buttons",
          controls: [1, 2, 3, 4, 5].map((n) => ({
            type: "button",
            id: `b${n}`,
            label: `B${n}`,
          })),
        }),
      ),
    ).toBe(true); // >4 buttons
  });
});

test.describe("landscape layout", () => {
  for (const viewport of LANDSCAPE_VIEWPORTS) {
    test(`generic, tank and xbox fit ${viewport.width}x${viewport.height} without overlaps`, () => {
      for (const schema of [GENERIC, TANK, XBOX]) {
        const layout = assertSane(schema, viewport);
        expect(layout.mode).toBe("landscape");
      }
    });
  }

  test("xbox roles follow array order: diamond, shoulders, aux", () => {
    const layout = resolveLayout(XBOX, { width: 667, height: 375 });
    const roleOf = Object.fromEntries(
      layout.controls.map((c) => [c.control.id, c.role]),
    );
    for (const id of ["left-stick", "right-stick", "dpad"])
      expect(roleOf[id]).toBe("stick");
    for (const id of ["a", "b", "x", "y"]) expect(roleOf[id]).toBe("primary");
    for (const id of ["lb", "rb", "lt", "rt"]) expect(roleOf[id]).toBe("shoulder");
    for (const id of ["ls", "rs", "view", "menu"]) expect(roleOf[id]).toBe("aux");
  });

  test("first two sticks take the bottom corners, the third is smaller", () => {
    const viewport = { width: 667, height: 375 };
    const layout = resolveLayout(XBOX, viewport);
    const byId = Object.fromEntries(layout.controls.map((c) => [c.control.id, c]));
    const left = byId["left-stick"];
    const right = byId["right-stick"];
    const dpad = byId["dpad"];
    expect(left.x).toBeLessThan(viewport.width / 3);
    expect(left.y).toBeGreaterThan(viewport.height / 2);
    expect(right.x).toBeGreaterThan((viewport.width * 2) / 3);
    expect(right.y).toBeGreaterThan(viewport.height / 2);
    expect(dpad.width).toBeLessThan(left.width);
    expect(dpad.y).toBeLessThan(left.y);
  });

  test("the diamond sits under the right thumb and A is its lowest button", () => {
    const viewport = { width: 667, height: 375 };
    const layout = resolveLayout(TANK, viewport);
    const byId = Object.fromEntries(layout.controls.map((c) => [c.control.id, c]));
    // Tank: fire (1st button) below boost (2nd), both on the right half.
    expect(byId["fire"].x).toBeGreaterThan(viewport.width / 2);
    expect(byId["boost"].x).toBeGreaterThan(viewport.width / 2);
    expect(byId["fire"].y).toBeGreaterThan(byId["boost"].y);

    const xbox = resolveLayout(XBOX, viewport);
    const xboxById = Object.fromEntries(xbox.controls.map((c) => [c.control.id, c]));
    expect(xboxById["a"].y).toBeGreaterThan(xboxById["b"].y);
    expect(xboxById["a"].y).toBeGreaterThan(xboxById["y"].y);
    expect(xboxById["b"].x).toBeGreaterThan(xboxById["x"].x);
  });

  test("a big schema in a portrait viewport still resolves (the oriented surface never hands it one)", () => {
    // resolveLayout never crashes on portrait; the component gates on
    // needsLandscape before calling it, but keep the pure function total.
    const layout = resolveLayout(XBOX, { width: 375, height: 667 });
    expect(layout.controls).toHaveLength(15);
  });

  test("degenerate all-joystick schemas stay on-screen", () => {
    const schema = controlSchemaSchema.parse({
      id: "sticks",
      name: "Sticks",
      controls: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        type: "joystick",
        id: `s${n}`,
      })),
    });
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      const layout = resolveLayout(schema, viewport);
      for (const c of layout.controls) {
        expect(c.x - c.width / 2).toBeGreaterThanOrEqual(0);
        expect(c.x + c.width / 2).toBeLessThanOrEqual(viewport.width);
        expect(c.y - c.height / 2).toBeGreaterThanOrEqual(0);
        expect(c.y + c.height / 2).toBeLessThanOrEqual(viewport.height);
      }
    }
  });

  test("buttons-only schemas get the bottom-right diamond", () => {
    const schema = controlSchemaSchema.parse({
      id: "quiz",
      name: "Quiz",
      controls: [
        { type: "button", id: "red", label: "Red" },
        { type: "button", id: "blue", label: "Blue" },
      ],
    });
    const viewport = { width: 667, height: 375 };
    const layout = assertSane(schema, viewport);
    for (const c of layout.controls) {
      expect(c.role).toBe("primary");
      expect(c.x).toBeGreaterThan(viewport.width / 2);
      expect(c.y).toBeGreaterThan(viewport.height / 3);
    }
  });
});

test.describe("layout hints", () => {
  const schemaOf = (input: object): ControlSchema =>
    controlSchemaSchema.parse(input);

  test("the hinted presets fit every viewport without overlaps", () => {
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      for (const schema of [TANK, XBOX, BRAWLER]) {
        assertSane(schema, viewport);
      }
    }
  });

  test("a zone hint beats array order for joystick corners", () => {
    const schema = schemaOf({
      id: "swapped",
      name: "Swapped",
      controls: [
        { type: "joystick", id: "first", zone: "right" },
        { type: "joystick", id: "second", zone: "left" },
      ],
    });
    const viewport = { width: 667, height: 375 };
    const byId = Object.fromEntries(
      assertSane(schema, viewport).controls.map((c) => [c.control.id, c]),
    );
    expect(byId["first"].x).toBeGreaterThan(viewport.width / 2);
    expect(byId["second"].x).toBeLessThan(viewport.width / 2);
  });

  test("brawler: buttons under the left thumb, stick under the right", () => {
    const viewport = { width: 667, height: 375 };
    const byId = Object.fromEntries(
      assertSane(BRAWLER, viewport).controls.map((c) => [c.control.id, c]),
    );
    expect(byId["move"].role).toBe("stick");
    expect(byId["move"].x).toBeGreaterThan((viewport.width * 2) / 3);
    for (const id of ["punch", "kick", "block"]) {
      expect(byId[id].role).toBe("primary");
      expect(byId[id].x).toBeLessThan(viewport.width / 2);
    }
    // Punch is first, so it takes the diamond's bottom (resting-thumb) slot.
    expect(byId["punch"].y).toBeGreaterThan(byId["kick"].y);
    // The aux pill stays out of the thumb arcs, on the top edge.
    expect(byId["taunt"].role).toBe("aux");
    expect(byId["taunt"].y).toBeLessThan(viewport.height / 4);
  });

  test("a thumb diamond holds four — hinted overflow spills to that side's shoulders", () => {
    const schema = schemaOf({
      id: "spill",
      name: "Spill",
      controls: [1, 2, 3, 4, 5, 6].map((n) => ({
        type: "button",
        id: `b${n}`,
        label: `B${n}`,
        zone: "right",
      })),
    });
    const viewport = { width: 667, height: 375 };
    const layout = assertSane(schema, viewport);
    const roles = layout.controls.map((c) => c.role);
    expect(roles.filter((r) => r === "primary")).toHaveLength(4);
    expect(roles.filter((r) => r === "shoulder")).toHaveLength(2);
    for (const c of layout.controls) {
      expect(c.x, `${c.control.id} stays on the right`).toBeGreaterThan(
        viewport.width / 2,
      );
    }
  });

  test("shoulder and aux zones place buttons along the top edge", () => {
    const schema = schemaOf({
      id: "tops",
      name: "Tops",
      controls: [
        { type: "joystick", id: "stick" },
        { type: "button", id: "l", label: "L", zone: "shoulder-left" },
        { type: "button", id: "r", label: "R", zone: "shoulder-right" },
        { type: "button", id: "menu", label: "Menu", zone: "aux" },
      ],
    });
    const viewport = { width: 667, height: 375 };
    const byId = Object.fromEntries(
      assertSane(schema, viewport).controls.map((c) => [c.control.id, c]),
    );
    expect(byId["l"].role).toBe("shoulder");
    expect(byId["r"].role).toBe("shoulder");
    expect(byId["menu"].role).toBe("aux");
    expect(byId["l"].x).toBeLessThan(viewport.width / 3);
    expect(byId["r"].x).toBeGreaterThan((viewport.width * 2) / 3);
    for (const id of ["l", "r", "menu"]) {
      expect(byId[id].y).toBeLessThan(viewport.height / 4);
    }
  });

  test("size hints scale within a zone: large > medium > small", () => {
    const schema = schemaOf({
      id: "sizes",
      name: "Sizes",
      controls: [
        { type: "button", id: "big", label: "Big", zone: "right", size: "large" },
        { type: "button", id: "mid", label: "Mid", zone: "right" },
        { type: "button", id: "wee", label: "Wee", zone: "right", size: "small" },
      ],
    });
    const viewport = { width: 667, height: 375 };
    const byId = Object.fromEntries(
      assertSane(schema, viewport).controls.map((c) => [c.control.id, c]),
    );
    expect(byId["big"].width).toBeGreaterThan(byId["mid"].width);
    expect(byId["mid"].width).toBeGreaterThan(byId["wee"].width);
  });

  test("a large-hinted stick outgrows a default one in the same slot", () => {
    const stickWidth = (size?: string) => {
      const schema = schemaOf({
        id: "one",
        name: "One",
        controls: [{ type: "joystick", id: "s", ...(size ? { size } : {}) }],
      });
      return resolveLayout(schema, { width: 667, height: 375 }).controls[0]
        .width;
    };
    expect(stickWidth("large")).toBeGreaterThan(stickWidth());
    expect(stickWidth()).toBeGreaterThan(stickWidth("small"));
  });

  test("hints on both thumbs shrink to fit the smallest viewport", () => {
    // Two sticks plus a full diamond under EACH thumb — more than the driver
    // should ask for, but the clusters must shrink instead of overlapping.
    const schema = schemaOf({
      id: "both",
      name: "Both",
      controls: [
        { type: "joystick", id: "ls", zone: "left" },
        { type: "joystick", id: "rs", zone: "right" },
        ...[1, 2, 3, 4].map((n) => ({
          type: "button",
          id: `l${n}`,
          label: `L${n}`,
          zone: "left",
        })),
        ...[1, 2, 3, 4].map((n) => ({
          type: "button",
          id: `r${n}`,
          label: `R${n}`,
          zone: "right",
        })),
      ],
    });
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      assertSane(schema, viewport);
    }
  });

  test("orientation hints override the control-count heuristic", () => {
    const landscapeQuiz = schemaOf({
      id: "quiz",
      name: "Quiz",
      orientation: "landscape",
      controls: [{ type: "button", id: "buzz", label: "Buzz" }],
    });
    expect(orientationLock(landscapeQuiz)).toBe("landscape");
    expect(needsLandscape(landscapeQuiz)).toBe(true);
    // Portrait viewport still resolves the landscape layout (the UI shows
    // the rotate prompt instead of rendering it).
    expect(
      resolveLayout(landscapeQuiz, { width: 375, height: 667 }).mode,
    ).toBe("landscape");

    const portraitRunner = schemaOf({
      id: "runner",
      name: "Runner",
      orientation: "portrait",
      controls: [
        { type: "joystick", id: "steer", mode: "x" },
        { type: "button", id: "jump", label: "Jump" },
        { type: "button", id: "pause", label: "Pause", zone: "aux" },
      ],
    });
    expect(orientationLock(portraitRunner)).toBe("portrait");
    expect(needsLandscape(portraitRunner)).toBe(false);
    const viewport = { width: 375, height: 667 };
    const layout = assertSane(portraitRunner, viewport);
    expect(layout.mode).toBe("one-hand");
    // The aux hint holds one-handed too: pause moves to the small top row.
    const byId = Object.fromEntries(
      layout.controls.map((c) => [c.control.id, c]),
    );
    expect(byId["pause"].role).toBe("aux");
    expect(byId["pause"].y).toBeLessThan(viewport.height / 4);
    expect(byId["jump"].y).toBeGreaterThan(viewport.height / 2);
  });

  test("a portrait-forced big schema stays on-screen in any viewport", () => {
    // orientation:"portrait" on an Xbox-sized schema is a driver bug, but the
    // engine must keep every control inside the viewport regardless.
    const schema = schemaOf({
      ...XBOX,
      id: "xbox-portrait",
      orientation: "portrait",
    });
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 667, height: 375 }, // held the wrong way; UI prompts, engine stays total
    ]) {
      const layout = resolveLayout(schema, viewport);
      expect(layout.mode).toBe("one-hand");
      expect(layout.controls).toHaveLength(15);
      for (const c of layout.controls) {
        expect(c.x - c.width / 2, `${c.control.id} left`).toBeGreaterThanOrEqual(0);
        expect(c.x + c.width / 2, `${c.control.id} right`).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(c.y - c.height / 2, `${c.control.id} top`).toBeGreaterThanOrEqual(0);
        expect(c.y + c.height / 2, `${c.control.id} bottom`).toBeLessThanOrEqual(
          viewport.height,
        );
      }
    }
  });
});

test.describe("driver positions", () => {
  const byId = (layout: { controls: ResolvedControl[] }, id: string) =>
    layout.controls.find((c) => c.control.id === id)!;

  test("the fixed preset fits every viewport without overlaps", () => {
    for (const viewport of LANDSCAPE_VIEWPORTS) assertSane(FIXED, viewport);
  });

  test("x / y put the control's center at that percentage of the viewport", () => {
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      const layout = resolveLayout(FIXED, viewport);
      const stick = byId(layout, "stick");
      expect(stick.x).toBeCloseTo(viewport.width * 0.22, 5);
      expect(stick.y).toBeCloseTo(viewport.height * 0.58, 5);
      const start = byId(layout, "start");
      expect(start.x).toBeCloseTo(viewport.width * 0.5, 5);
      // y: 8% is inside the top edge for a small pill; the box is not clamped.
      expect(start.y).toBeCloseTo(viewport.height * 0.08, 5);
    }
  });

  test("each axis is independent: an omitted axis keeps the engine's draft", () => {
    const viewport = { width: 844, height: 390 };
    const base = controlSchemaSchema.parse({
      id: "half",
      name: "Half",
      orientation: "landscape",
      controls: [
        { type: "joystick", id: "move" },
        { type: "button", id: "fire", label: "Fire" },
      ],
    });
    const draft = resolveLayout(base, viewport);
    const positioned = resolveLayout(
      controlSchemaSchema.parse({
        ...base,
        controls: [
          { type: "joystick", id: "move", x: 50 },
          { type: "button", id: "fire", label: "Fire", y: 50 },
        ],
      }),
      viewport,
    );
    const move = byId(positioned, "move");
    expect(move.x).toBeCloseTo(viewport.width / 2, 5);
    expect(move.y).toBe(byId(draft, "move").y);
    expect(move.width).toBe(byId(draft, "move").width);
    const fire = byId(positioned, "fire");
    expect(fire.x).toBe(byId(draft, "fire").x);
    expect(fire.y).toBeCloseTo(viewport.height / 2, 5);
    expect(fire.role).toBe(byId(draft, "fire").role);
  });

  test("edge positions are clamped so the whole box stays on-screen", () => {
    const schema = controlSchemaSchema.parse({
      id: "edges",
      name: "Edges",
      orientation: "landscape",
      controls: [
        { type: "joystick", id: "tl", x: 0, y: 0 },
        { type: "joystick", id: "br", x: 100, y: 100 },
        { type: "button", id: "a", label: "A", x: 100, y: 0 },
      ],
    });
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      const layout = assertSane(schema, viewport);
      const tl = byId(layout, "tl");
      expect(tl.x).toBe(tl.width / 2);
      expect(tl.y).toBe(tl.height / 2);
      const br = byId(layout, "br");
      expect(br.x).toBe(viewport.width - br.width / 2);
      expect(br.y).toBe(viewport.height - br.height / 2);
      const a = byId(layout, "a");
      expect(a.x).toBe(viewport.width - a.width / 2);
      expect(a.y).toBe(a.height / 2);
    }
  });

  test("positions apply in the one-hand layout too, against the portrait box", () => {
    const schema = controlSchemaSchema.parse({
      id: "portrait-fixed",
      name: "Portrait fixed",
      orientation: "portrait",
      controls: [
        { type: "joystick", id: "move", x: 50, y: 80 },
        { type: "button", id: "a", label: "A", x: 30, y: 30 },
        { type: "button", id: "b", label: "B", x: 70, y: 30 },
      ],
    });
    const viewport = { width: 390, height: 844 };
    const layout = assertSane(schema, viewport);
    expect(layout.mode).toBe("one-hand");
    expect(byId(layout, "move").x).toBeCloseTo(195, 5);
    expect(byId(layout, "move").y).toBeCloseTo(844 * 0.8, 5);
    expect(byId(layout, "a").x).toBeCloseTo(390 * 0.3, 5);
    expect(byId(layout, "b").y).toBeCloseTo(844 * 0.3, 5);
  });

  test("sensor controls and unpositioned schemas are untouched", () => {
    const viewport = { width: 844, height: 390 };
    const draft = resolveLayout(XBOX, viewport);
    expect(applyDriverPositions(draft, viewport)).toBe(draft);
    for (const control of XBOX.controls) {
      expect(hasDriverPosition(control)).toBe(false);
    }
    expect(hasDriverPosition({ type: "gyro", id: "g", mode: "full", range: 45 })).toBe(
      false,
    );
    expect(hasDriverPosition({ type: "button", id: "b", label: "B", x: 10 })).toBe(
      true,
    );
  });
});

test.describe("one-hand layout", () => {
  const PORTRAIT: Viewport[] = [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ];

  for (const viewport of PORTRAIT) {
    test(`small schemas go one-handed at ${viewport.width}x${viewport.height}`, () => {
      for (const schema of [GENERIC, TANK]) {
        const layout = assertSane(schema, viewport);
        expect(layout.mode).toBe("one-hand");
      }
    });
  }

  test("stick sits bottom-center with buttons above it", () => {
    const viewport = { width: 375, height: 667 };
    const layout = resolveLayout(TANK, viewport);
    const byId = Object.fromEntries(layout.controls.map((c) => [c.control.id, c]));
    const drive = byId["drive"];
    expect(drive.x).toBeCloseTo(viewport.width / 2, 5);
    expect(drive.y).toBeGreaterThan(viewport.height * 0.6);
    expect(byId["fire"].y).toBeLessThan(drive.y - drive.height / 2);
    expect(byId["boost"].y).toBeLessThan(drive.y - drive.height / 2);
  });

  test("landscape viewports keep the landscape layout even for small schemas", () => {
    const layout = resolveLayout(TANK, { width: 667, height: 375 });
    expect(layout.mode).toBe("landscape");
  });
});

test.describe("joystick modes", () => {
  const RACER = presetSchema("racer");

  for (const viewport of LANDSCAPE_VIEWPORTS) {
    test(`the racer preset (x/y/dpad sticks) fits ${viewport.width}x${viewport.height}`, () => {
      assertSane(RACER, viewport);
    });
  }

  test("single-axis sticks become pills along their axis, dpads stay square", () => {
    const layout = resolveLayout(RACER, { width: 667, height: 375 });
    const byId = Object.fromEntries(layout.controls.map((c) => [c.control.id, c]));
    expect(byId["steer"].width).toBeGreaterThan(byId["steer"].height);
    expect(byId["throttle"].height).toBeGreaterThan(byId["throttle"].width);
    expect(byId["look"].width).toBe(byId["look"].height);
    // Same slots as any other sticks: steer bottom-left, throttle
    // bottom-right, dpad small upper-left.
    expect(byId["steer"].x).toBeLessThan(333);
    expect(byId["throttle"].x).toBeGreaterThan(334);
    expect(byId["look"].width).toBeLessThan(byId["throttle"].height);
  });

  test("a single-axis stick keeps a thumb-sized cross axis", () => {
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      const layout = resolveLayout(RACER, viewport);
      for (const c of layout.controls) {
        if (c.role !== "stick") continue;
        expect(Math.min(c.width, c.height)).toBeGreaterThanOrEqual(48);
      }
    }
  });

  test("a relative pad takes a square box in a normal stick's slot", () => {
    const AIM = presetSchema("aim");
    for (const viewport of LANDSCAPE_VIEWPORTS) {
      const layout = assertSane(AIM, viewport);
      const aim = layout.controls.find((c) => c.control.id === "aim")!;
      const move = layout.controls.find((c) => c.control.id === "move")!;
      expect(aim.role).toBe("stick");
      expect(aim.width).toBe(aim.height);
      // Hinted right thumb, and "large" against the move stick's default.
      expect(aim.x).toBeGreaterThan(viewport.width / 2);
      expect(move.x).toBeLessThan(viewport.width / 2);
      expect(aim.width).toBeGreaterThan(move.width);
    }
  });

  test("a relative pad is a joystick like any other for orientation", () => {
    const schema = controlSchemaSchema.parse({
      id: "aim-only",
      name: "Aim only",
      controls: [{ type: "joystick", id: "aim", mode: "relative" }],
    });
    expect(needsLandscape(schema)).toBe(false);
    const layout = assertSane(schema, { width: 375, height: 667 });
    expect(layout.mode).toBe("one-hand");
    const aim = layout.controls[0];
    expect(aim.width).toBe(aim.height);
    expect(aim.x).toBeCloseTo(375 / 2, 5);
  });

  test("an x-only one-hand schema lays out in portrait", () => {
    const schema = controlSchemaSchema.parse({
      id: "slider",
      name: "Slider",
      controls: [
        { type: "joystick", id: "steer", mode: "x" },
        { type: "button", id: "go", label: "Go" },
      ],
    });
    expect(needsLandscape(schema)).toBe(false);
    const viewport = { width: 375, height: 667 };
    const layout = assertSane(schema, viewport);
    expect(layout.mode).toBe("one-hand");
    const steer = layout.controls.find((c) => c.control.id === "steer")!;
    expect(steer.width).toBeGreaterThan(steer.height);
    expect(steer.x).toBeCloseTo(viewport.width / 2, 5);
  });
});

test.describe("gyro controls and layout", () => {
  // The tilt sensor is hardware, not an on-screen control: adding a gyro to a
  // schema must not move, resize or reorient anything the layout engine
  // places, even as the schema's most-important (first) control.
  const addGyro = (schema: ControlSchema): ControlSchema =>
    controlSchemaSchema.parse({
      ...schema,
      id: `${schema.id}-gyro`,
      controls: [{ type: "gyro", id: "lean" }, ...schema.controls],
    });

  test("a gyro control never affects needsLandscape", () => {
    for (const schema of [GENERIC, TANK, XBOX]) {
      expect(needsLandscape(addGyro(schema))).toBe(needsLandscape(schema));
    }
  });

  test("the resolved layout is identical with and without a gyro control", () => {
    const viewports: Viewport[] = [
      ...LANDSCAPE_VIEWPORTS,
      { width: 375, height: 667 }, // portrait: the one-hand path too
    ];
    for (const schema of [GENERIC, TANK, XBOX]) {
      for (const viewport of viewports) {
        const withGyro = resolveLayout(addGyro(schema), viewport);
        expect(withGyro).toEqual(resolveLayout(schema, viewport));
      }
    }
  });

  test("a gyro-only schema resolves to an empty (but valid) layout", () => {
    const schema = controlSchemaSchema.parse({
      id: "pure-tilt",
      name: "Pure tilt",
      controls: [{ type: "gyro", id: "lean" }],
    });
    expect(needsLandscape(schema)).toBe(false);
    expect(resolveLayout(schema, { width: 667, height: 375 }).controls).toEqual(
      [],
    );
  });
});

test.describe("pointToDpadDirection", () => {
  const R = 100;

  test("the center dead zone reads as centered", () => {
    expect(pointToDpadDirection(0, 0, R)).toBe("c");
    const inside = R * DPAD_DEADZONE - 1;
    expect(pointToDpadDirection(inside, 0, R)).toBe("c");
    expect(pointToDpadDirection(0, -inside, R)).toBe("c");
  });

  test("maps the 8 sector centers (y positive downwards)", () => {
    expect(pointToDpadDirection(80, 0, R)).toBe("r");
    expect(pointToDpadDirection(80, 80, R)).toBe("dr");
    expect(pointToDpadDirection(0, 80, R)).toBe("d");
    expect(pointToDpadDirection(-80, 80, R)).toBe("dl");
    expect(pointToDpadDirection(-80, 0, R)).toBe("l");
    expect(pointToDpadDirection(-80, -80, R)).toBe("ul");
    expect(pointToDpadDirection(0, -80, R)).toBe("u");
    expect(pointToDpadDirection(80, -80, R)).toBe("ur");
  });

  test("sectors span 45° around their center", () => {
    // 10° above the x-axis is still right; 30° crosses into the diagonal.
    const at = (degrees: number) => {
      const rad = (degrees * Math.PI) / 180;
      return pointToDpadDirection(Math.cos(rad) * 80, Math.sin(rad) * 80, R);
    };
    expect(at(10)).toBe("r");
    expect(at(-10)).toBe("r");
    expect(at(30)).toBe("dr");
    expect(at(70)).toBe("d");
    expect(at(190)).toBe("l");
    expect(at(260)).toBe("u");
    expect(at(-30)).toBe("ur");
  });
});

test.describe("relative stick values", () => {
  // A relative pad has no home position: every touch re-centers, so the
  // value is the drag from the touch-down point and the throw is a fixed
  // radius around it, never the distance to the pad's own center.
  test("travel is a fraction of the pad's shorter side, with a floor", () => {
    expect(relativeStickTravel(200, 200)).toBeCloseTo(200 * RELATIVE_STICK_TRAVEL, 5);
    expect(relativeStickTravel(300, 120)).toBeCloseTo(120 * RELATIVE_STICK_TRAVEL, 5);
    // A shrunken pad (the degenerate overflow row) stays usable.
    expect(relativeStickTravel(40, 40)).toBe(24);
    expect(relativeStickTravel(0, 0)).toBe(24);
  });

  test("no drag is neutral, however far from the pad's center the touch was", () => {
    expect(relativeStickValue(0, 0, 50)).toEqual({ x: 0, y: 0, dx: 0, dy: 0 });
  });

  test("the value is the drag, normalized to the travel radius", () => {
    expect(relativeStickValue(25, 0, 50).x).toBeCloseTo(0.5, 5);
    expect(relativeStickValue(-50, 0, 50).x).toBeCloseTo(-1, 5);
    // y is positive downwards, like every other axis on the wire.
    expect(relativeStickValue(0, 20, 50).y).toBeCloseTo(0.4, 5);
    expect(relativeStickValue(0, -50, 50).y).toBeCloseTo(-1, 5);
  });

  test("dragging past the travel radius clamps to the unit circle", () => {
    const far = relativeStickValue(500, 0, 50);
    expect(far.x).toBeCloseTo(1, 5);
    expect(far.dx).toBeCloseTo(50, 5);
    // Far outside the pad in both axes: direction kept, magnitude capped.
    const diagonal = relativeStickValue(300, 300, 50);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 5);
    expect(diagonal.x).toBeCloseTo(diagonal.y, 5);
    for (const [dx, dy] of [
      [10, 5],
      [80, -140],
      [-1000, 3],
      [-30, -30],
    ]) {
      const { x, y } = relativeStickValue(dx, dy, 50);
      expect(Math.hypot(x, y), `${dx},${dy}`).toBeLessThanOrEqual(1.000001);
    }
  });

  test("the drawn knob offset matches the value that was sent", () => {
    for (const [dx, dy] of [
      [0, 0],
      [12, -7],
      [49, 0],
      [400, 400],
    ]) {
      const value = relativeStickValue(dx, dy, 50);
      expect(value.dx).toBeCloseTo(value.x * 50, 5);
      expect(value.dy).toBeCloseTo(value.y * 50, 5);
    }
  });

  test("a zero-sized pad reports neutral instead of dividing by zero", () => {
    expect(relativeStickValue(10, 10, 0)).toEqual({ x: 0, y: 0, dx: 0, dy: 0 });
  });
});

test.describe("touchpad controls", () => {
  const byId = (layout: { controls: ResolvedControl[] }, id: string) =>
    layout.controls.find((c) => c.control.id === id)!;
  const touchpad = (extra: object = {}) =>
    controlSchemaSchema.parse({
      id: "pads",
      name: "Pads",
      controls: [{ type: "touchpad", id: "pad", ...extra }],
    });

  test("the mouse preset fits every landscape viewport without overlaps", () => {
    for (const viewport of LANDSCAPE_VIEWPORTS) assertSane(MOUSE, viewport);
  });

  test("the pad keeps its declared aspect in every layout", () => {
    for (const aspect of [0.5, 1, 1.5, 4]) {
      for (const viewport of [...LANDSCAPE_VIEWPORTS, { width: 390, height: 844 }]) {
        const pad = byId(resolveLayout(touchpad({ aspect }), viewport), "pad");
        expect(pad.width / pad.height).toBeCloseTo(aspect, 5);
        expect(pad.x - pad.width / 2).toBeGreaterThanOrEqual(0);
        expect(pad.x + pad.width / 2).toBeLessThanOrEqual(viewport.width);
      }
    }
    const square = byId(resolveLayout(touchpad(), { width: 844, height: 390 }), "pad");
    expect(square.width).toBeCloseTo(square.height, 5);
  });

  test("a wide pad sits flush in its bottom corner", () => {
    const viewport = { width: 844, height: 390 };
    const layout = resolveLayout(
      controlSchemaSchema.parse({
        id: "m",
        name: "M",
        controls: [
          { type: "touchpad", id: "pad", aspect: 2, zone: "right" },
          { type: "button", id: "a", label: "A", zone: "left" },
        ],
      }),
      viewport,
    );
    const pad = byId(layout, "pad");
    const a = byId(layout, "a");
    // Same inset from the right as from the bottom.
    expect(viewport.width - (pad.x + pad.width / 2)).toBeCloseTo(
      viewport.height - (pad.y + pad.height / 2),
      5,
    );
    expect(pad.role).toBe("stick");
    expect(a.x + a.width / 2).toBeLessThan(pad.x - pad.width / 2);
  });

  test("a touchpad counts as a stick for the orientation heuristic", () => {
    expect(needsLandscape(touchpad())).toBe(false);
    expect(needsLandscape(MOUSE)).toBe(true);
  });
});
