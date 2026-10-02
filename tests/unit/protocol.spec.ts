import { test, expect } from "@playwright/test";
import {
  GAMEPAD_DEFAULT_COLORS,
  GAMEPAD_DPAD_DIRECTIONS,
  GAMEPAD_GYRO_RANGE_DEFAULT,
  GAMEPAD_MOTION_BATCH_MAX,
  GAMEPAD_PROTOCOL_VERSION,
  GENERIC_GAMEPAD_SCHEMA,
  controlSchemaSchema,
  dpadToVector,
  gamepadCodeSchema,
  gamepadErrorCodeSchema,
  gamepadInputFrameSchema,
  gamepadMotionSampleSchema,
  gamepadPlayerClientMessageSchema,
  gamepadPlayerNameSchema,
  gamepadServerMessageSchema,
  gamepadSessionConfigSchema,
  hasCapability,
  hasSchemaChoice,
  isSelectableSchemaId,
  PHYSICAL_GAMEPAD_CONTROLS,
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  schemaNeedsMotionSensors,
} from "@kapula/protocol";

test.describe("player name validation", () => {
  test("accepts sensible names", () => {
    expect(gamepadPlayerNameSchema.parse("Alice")).toBe("Alice");
    expect(gamepadPlayerNameSchema.parse("Äiti 42")).toBe("Äiti 42");
    expect(gamepadPlayerNameSchema.parse("player_one-2")).toBe("player_one-2");
  });

  test("trims and collapses whitespace", () => {
    expect(gamepadPlayerNameSchema.parse("  Bob  ")).toBe("Bob");
    expect(gamepadPlayerNameSchema.parse("A   B")).toBe("A B");
  });

  test("rejects empty, too long and symbol-laden names", () => {
    expect(() => gamepadPlayerNameSchema.parse("")).toThrow();
    expect(() => gamepadPlayerNameSchema.parse("   ")).toThrow();
    expect(() => gamepadPlayerNameSchema.parse("a".repeat(17))).toThrow();
    expect(() => gamepadPlayerNameSchema.parse("fire🔥")).toThrow();
    expect(() => gamepadPlayerNameSchema.parse("<script>")).toThrow();
    expect(() => gamepadPlayerNameSchema.parse("a!b")).toThrow();
  });
});

test.describe("join/setup codes", () => {
  test("normalizes case and whitespace", () => {
    expect(gamepadCodeSchema.parse(" abc234 ")).toBe("ABC234");
  });

  test("rejects wrong length and ambiguous characters", () => {
    expect(() => gamepadCodeSchema.parse("ABC23")).toThrow();
    expect(() => gamepadCodeSchema.parse("ABC2345")).toThrow();
    // 0, O, 1, I, L are excluded from the alphabet
    expect(() => gamepadCodeSchema.parse("ABC10I")).toThrow();
  });
});

test.describe("session config validation", () => {
  test("empty config gets full defaults", () => {
    const config = gamepadSessionConfigSchema.parse({});
    expect(config.minPlayers).toBe(1);
    expect(config.maxPlayers).toBe(8);
    expect(config.schemas).toEqual([GENERIC_GAMEPAD_SCHEMA]);
    expect(config.colors).toBeUndefined();
    expect(config.capabilities).toEqual([]);
    expect(config.disallowLayoutCustomization).toBe(false);
  });

  test("disallowLayoutCustomization is an opt-in boolean that round-trips", () => {
    const locked = gamepadSessionConfigSchema.parse({
      disallowLayoutCustomization: true,
    });
    expect(locked.disallowLayoutCustomization).toBe(true);
    expect(gamepadSessionConfigSchema.parse(locked)).toEqual(locked);
    expect(() =>
      gamepadSessionConfigSchema.parse({ disallowLayoutCustomization: "yes" }),
    ).toThrow();
  });

  test("driverAppUuid is optional and must be a UUID", () => {
    expect(gamepadSessionConfigSchema.parse({}).driverAppUuid).toBeUndefined();
    const uuid = "7d3a2c1e-5b64-4f0a-9c8d-2e1f0b6a4d95";
    expect(gamepadSessionConfigSchema.parse({ driverAppUuid: uuid }).driverAppUuid).toBe(
      uuid,
    );
    expect(() =>
      gamepadSessionConfigSchema.parse({ driverAppUuid: "tank-game" }),
    ).toThrow();
    // Players learn it from the snapshot, which carries the full config.
    const snapshot = gamepadServerMessageSchema.parse({
      type: "snapshot",
      snapshot: {
        protocolVersion: GAMEPAD_PROTOCOL_VERSION,
        sessionId: "s",
        state: "in_progress",
        config: { driverAppUuid: uuid },
        driverConnected: true,
        players: [],
      },
    });
    expect(snapshot.type === "snapshot" && snapshot.snapshot.config.driverAppUuid).toBe(
      uuid,
    );
  });

  test("rejects minPlayers above maxPlayers", () => {
    expect(() =>
      gamepadSessionConfigSchema.parse({ minPlayers: 4, maxPlayers: 2 }),
    ).toThrow();
  });

  test("rejects duplicate schema ids and control ids", () => {
    const schema = GENERIC_GAMEPAD_SCHEMA;
    expect(() =>
      gamepadSessionConfigSchema.parse({ schemas: [schema, schema] }),
    ).toThrow();
    expect(() =>
      gamepadSessionConfigSchema.parse({
        schemas: [
          {
            id: "dup-controls",
            name: "Dup",
            controls: [
              { type: "button", id: "a", label: "A" },
              { type: "button", id: "a", label: "A again" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  test("colors must be unique and cover maxPlayers", () => {
    expect(() =>
      gamepadSessionConfigSchema.parse({
        maxPlayers: 2,
        colors: ["#FF0000", "#FF0000"],
      }),
    ).toThrow();
    expect(() =>
      gamepadSessionConfigSchema.parse({
        maxPlayers: 3,
        colors: ["#FF0000", "#00FF00"],
      }),
    ).toThrow();
    const ok = gamepadSessionConfigSchema.parse({
      maxPlayers: 2,
      colors: ["#FF0000", "#00FF00", "#0000FF"],
    });
    expect(ok.colors).toHaveLength(3);
  });

  test("default palette covers the player cap", () => {
    expect(new Set(GAMEPAD_DEFAULT_COLORS).size).toBe(
      GAMEPAD_DEFAULT_COLORS.length,
    );
    expect(GAMEPAD_DEFAULT_COLORS.length).toBeGreaterThanOrEqual(12);
  });
});

/**
 * The roster is the lost-session recovery path: a driver hands back the
 * players it remembers, and the session is sized to exactly them.
 */
test.describe("roster sessions", () => {
  const roster = [
    { name: "Player 1", color: "#FF6B6B" },
    { name: "Player 2", color: "#6BCB77" },
    { name: "Player 3", color: "#FFD93D" },
  ];

  test("sizes the session to the roster and normalizes names", () => {
    const config = gamepadSessionConfigSchema.parse({
      roster: [...roster, { name: "  Late   Joiner ", color: "#4D96FF" }],
    });
    expect(config.minPlayers).toBe(4);
    expect(config.maxPlayers).toBe(4);
    expect(config.roster?.[3]?.name).toBe("Late Joiner");
  });

  test("player counts may be stated only when they match the roster", () => {
    expect(
      gamepadSessionConfigSchema.parse({ roster, minPlayers: 3, maxPlayers: 3 })
        .maxPlayers,
    ).toBe(3);
    expect(() =>
      gamepadSessionConfigSchema.parse({ roster, minPlayers: 1 }),
    ).toThrow(/minPlayers/);
    expect(() =>
      gamepadSessionConfigSchema.parse({ roster, maxPlayers: 8 }),
    ).toThrow(/maxPlayers/);
  });

  test("names are unique case-insensitively, colors unique and from the palette", () => {
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster: [roster[0], { name: "player 1", color: "#4D96FF" }],
      }),
    ).toThrow(/Duplicate roster name/);
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster: [roster[0], { name: "Other", color: "#FF6B6B" }],
      }),
    ).toThrow(/Duplicate roster color/);
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster: [{ name: "Off palette", color: "#123456" }],
      }),
    ).toThrow(/not in the palette/);
    // A custom palette must cover the roster (it is maxPlayers) and hold its
    // colors.
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster,
        colors: ["#FF6B6B", "#6BCB77"],
      }),
    ).toThrow();
    const custom = gamepadSessionConfigSchema.parse({
      roster,
      colors: ["#FF6B6B", "#6BCB77", "#FFD93D"],
    });
    expect(custom.maxPlayers).toBe(3);
  });

  test("rejects an empty roster and invalid entries", () => {
    expect(() => gamepadSessionConfigSchema.parse({ roster: [] })).toThrow();
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster: [{ name: "!!!", color: "#FF6B6B" }],
      }),
    ).toThrow();
    expect(() =>
      gamepadSessionConfigSchema.parse({
        roster: [{ name: "Player 1", color: "red" }],
      }),
    ).toThrow();
  });

  test("a parsed roster config round-trips through parsing (stored config)", () => {
    const once = gamepadSessionConfigSchema.parse({ roster });
    expect(gamepadSessionConfigSchema.parse(once)).toEqual(once);
  });

  test("free-join configs are unaffected", () => {
    const config = gamepadSessionConfigSchema.parse({ minPlayers: 2 });
    expect(config.roster).toBeUndefined();
    expect(config.minPlayers).toBe(2);
    expect(config.maxPlayers).toBe(8);
  });
});

test.describe("capabilities", () => {
  const parse = (capabilities: unknown) =>
    gamepadSessionConfigSchema.safeParse({ capabilities });

  test("are kept verbatim, unknown names included", () => {
    // The server never interprets the list: a driver may declare something
    // this version has never heard of and an older phone just ignores it.
    const config = gamepadSessionConfigSchema.parse({
      capabilities: ["webrtc", "something-from-2030"],
    });
    expect(config.capabilities).toEqual(["webrtc", "something-from-2030"]);
    expect(hasCapability(config, "webrtc")).toBe(true);
    expect(hasCapability(config, "something-from-2030")).toBe(true);
    expect(hasCapability(config, "not-declared")).toBe(false);
  });

  test("a config without the field declares none", () => {
    // Configs stored before the field existed re-parse to the same shape.
    const stored = JSON.parse(
      JSON.stringify({ game: "Tanks", schemas: [GENERIC_GAMEPAD_SCHEMA] }),
    );
    const config = gamepadSessionConfigSchema.parse(stored);
    expect(config.capabilities).toEqual([]);
    expect(hasCapability(config, "webrtc")).toBe(false);
  });

  test("round-trips through storage", () => {
    const config = gamepadSessionConfigSchema.parse({
      capabilities: ["webrtc"],
    });
    const reparsed = gamepadSessionConfigSchema.parse(
      JSON.parse(JSON.stringify(config)),
    );
    expect(reparsed.capabilities).toEqual(["webrtc"]);
  });

  test("rejects non-strings, empty names, long names and long lists", () => {
    expect(parse(["ok"]).success).toBe(true);
    expect(parse([1]).success).toBe(false);
    expect(parse([""]).success).toBe(false);
    expect(parse(["a".repeat(32)]).success).toBe(true);
    expect(parse(["a".repeat(33)]).success).toBe(false);
    expect(parse(Array.from({ length: 16 }, (_, i) => `c${i}`)).success).toBe(
      true,
    );
    expect(parse(Array.from({ length: 17 }, (_, i) => `c${i}`)).success).toBe(
      false,
    );
    expect(parse("webrtc").success).toBe(false);
  });
});

test.describe("error codes", () => {
  // A closed set so a driver can switch on it. Adding a code later is an
  // additive protocol change; removing or renaming one is not.
  test("every code the server sends parses", () => {
    for (const code of [
      "invalid_state",
      "cannot_start",
      "profile_taken",
      "profile_locked",
      "unknown_schema",
      "unknown_player",
    ]) {
      expect(gamepadErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(gamepadErrorCodeSchema.options).toHaveLength(6);
  });

  test("an unknown code is not part of the contract", () => {
    expect(gamepadErrorCodeSchema.safeParse("kaboom").success).toBe(false);
    expect(
      gamepadServerMessageSchema.safeParse({
        type: "error",
        code: "not_a_code",
        message: "nope",
      }).success,
    ).toBe(false);
  });
});

test.describe("joystick modes", () => {
  test("mode defaults to full and accepts every documented value", () => {
    const parsed = controlSchemaSchema.parse({
      id: "modes",
      name: "Modes",
      controls: [
        { type: "joystick", id: "stick" },
        { type: "joystick", id: "aim", mode: "relative" },
        { type: "joystick", id: "steer", mode: "x" },
        { type: "joystick", id: "throttle", mode: "y" },
        { type: "joystick", id: "look", mode: "dpad" },
      ],
    });
    const modes = parsed.controls.map((c) =>
      c.type === "joystick" ? c.mode : null,
    );
    expect(modes).toEqual(["full", "relative", "x", "y", "dpad"]);
  });

  test("rejects unknown modes and modes on buttons", () => {
    expect(() =>
      controlSchemaSchema.parse({
        id: "bad",
        name: "Bad",
        controls: [{ type: "joystick", id: "s", mode: "diagonal" }],
      }),
    ).toThrow();
    // Buttons silently ignore an accidental mode key (zod strips it) but the
    // result must not carry one.
    const parsed = controlSchemaSchema.parse({
      id: "b",
      name: "B",
      controls: [{ type: "button", id: "a", label: "A", mode: "x" }],
    });
    expect("mode" in parsed.controls[0]).toBe(false);
  });

  test("the generic schema round-trips unchanged through parsing", () => {
    expect(controlSchemaSchema.parse(GENERIC_GAMEPAD_SCHEMA)).toEqual(
      GENERIC_GAMEPAD_SCHEMA,
    );
  });
});

test.describe("layout hints", () => {
  test("zone, size and orientation parse; missing hints stay absent", () => {
    const parsed = controlSchemaSchema.parse({
      id: "hints",
      name: "Hints",
      orientation: "landscape",
      controls: [
        { type: "joystick", id: "move", zone: "left", size: "large" },
        { type: "button", id: "fire", label: "Fire", zone: "right" },
        { type: "button", id: "pause", label: "Pause", zone: "aux", size: "small" },
      ],
    });
    expect(parsed.orientation).toBe("landscape");
    expect(parsed.controls[0]).toMatchObject({ zone: "left", size: "large" });
    expect(parsed.controls[1]).toMatchObject({ zone: "right" });
    // Hints are optional — an omitted hint must not be defaulted, so the
    // layout engine can tell "no opinion" from an explicit choice.
    expect("size" in parsed.controls[1]).toBe(false);
    expect("zone" in parsed.controls[2] && "size" in parsed.controls[2]).toBe(
      true,
    );
  });

  test("orientation defaults to auto", () => {
    expect(
      controlSchemaSchema.parse({
        id: "plain",
        name: "Plain",
        controls: [{ type: "button", id: "a", label: "A" }],
      }).orientation,
    ).toBe("auto");
  });

  test("rejects unknown zones, sizes and orientations", () => {
    const withControl = (control: object) => ({
      id: "bad",
      name: "Bad",
      controls: [control],
    });
    expect(() =>
      controlSchemaSchema.parse(
        withControl({ type: "button", id: "a", label: "A", zone: "bottom" }),
      ),
    ).toThrow();
    expect(() =>
      controlSchemaSchema.parse(
        withControl({ type: "joystick", id: "s", size: "huge" }),
      ),
    ).toThrow();
    expect(() =>
      controlSchemaSchema.parse({
        id: "bad",
        name: "Bad",
        orientation: "sideways",
        controls: [{ type: "button", id: "a", label: "A" }],
      }),
    ).toThrow();
  });

  test("gyro controls take no layout hints — the sensor has no footprint", () => {
    const parsed = controlSchemaSchema.parse({
      id: "tilt",
      name: "Tilt",
      controls: [{ type: "gyro", id: "lean", zone: "left", size: "large" }],
    });
    expect("zone" in parsed.controls[0]).toBe(false);
    expect("size" in parsed.controls[0]).toBe(false);
  });

  test("x / y positions parse as percentages, each axis on its own", () => {
    const parsed = controlSchemaSchema.parse({
      id: "fixed",
      name: "Fixed",
      controls: [
        { type: "joystick", id: "move", x: 20, y: 60 },
        { type: "button", id: "fire", label: "Fire", x: 80 },
        { type: "button", id: "jump", label: "Jump", y: 0 },
        { type: "button", id: "free", label: "Free" },
      ],
    });
    expect(parsed.controls[0]).toMatchObject({ x: 20, y: 60 });
    expect(parsed.controls[1]).toMatchObject({ x: 80 });
    expect("y" in parsed.controls[1]).toBe(false);
    expect(parsed.controls[2]).toMatchObject({ y: 0 });
    expect("x" in parsed.controls[3] || "y" in parsed.controls[3]).toBe(false);
    // Stored configs round-trip unchanged.
    expect(controlSchemaSchema.parse(parsed)).toEqual(parsed);
  });

  test("positions outside 0–100 or non-numeric are rejected", () => {
    const withControl = (control: object) =>
      controlSchemaSchema.parse({ id: "bad", name: "Bad", controls: [control] });
    expect(() =>
      withControl({ type: "button", id: "a", label: "A", x: 101 }),
    ).toThrow();
    expect(() =>
      withControl({ type: "joystick", id: "s", y: -1 }),
    ).toThrow();
    expect(() =>
      withControl({ type: "button", id: "a", label: "A", x: "50%" }),
    ).toThrow();
    // Sensors have no footprint: positions are dropped, not rejected.
    const sensor = withControl({ type: "gyro", id: "lean", x: 50, y: 50 });
    expect("x" in sensor.controls[0] || "y" in sensor.controls[0]).toBe(false);
  });

  test("the generic schema still round-trips with hints in the vocabulary", () => {
    expect(GENERIC_GAMEPAD_SCHEMA.orientation).toBe("auto");
    expect(controlSchemaSchema.parse(GENERIC_GAMEPAD_SCHEMA)).toEqual(
      GENERIC_GAMEPAD_SCHEMA,
    );
  });
});

test.describe("gyro controls", () => {
  const gyroSchema = (gyro: object) =>
    controlSchemaSchema.parse({
      id: "tilt",
      name: "Tilt",
      controls: [gyro, { type: "button", id: "fire", label: "Fire" }],
    });

  test("defaults to both tilt axes at the default range", () => {
    const parsed = gyroSchema({ type: "gyro", id: "lean" });
    const gyro = parsed.controls[0];
    expect(gyro).toEqual({
      type: "gyro",
      id: "lean",
      mode: "full",
      range: GAMEPAD_GYRO_RANGE_DEFAULT,
    });
  });

  test("accepts single-axis modes and a custom range", () => {
    const parsed = gyroSchema({ type: "gyro", id: "steer", mode: "x", range: 25 });
    expect(parsed.controls[0]).toMatchObject({ mode: "x", range: 25 });
    expect(
      gyroSchema({ type: "gyro", id: "pitch", mode: "y" }).controls[0],
    ).toMatchObject({ mode: "y" });
  });

  test("rejects out-of-range ranges and joystick-only modes", () => {
    expect(() => gyroSchema({ type: "gyro", id: "g", range: 4 })).toThrow();
    expect(() => gyroSchema({ type: "gyro", id: "g", range: 91 })).toThrow();
    // Tilt is continuous by nature; there is no discrete dpad mode for it,
    // and "relative" is a touch gesture with no meaning for a sensor.
    expect(() => gyroSchema({ type: "gyro", id: "g", mode: "dpad" })).toThrow();
    expect(() =>
      gyroSchema({ type: "gyro", id: "g", mode: "relative" }),
    ).toThrow();
  });

  test("allows at most one gyro control per schema — phones have one sensor", () => {
    expect(() =>
      controlSchemaSchema.parse({
        id: "double",
        name: "Double",
        controls: [
          { type: "gyro", id: "lean" },
          { type: "gyro", id: "steer", mode: "x" },
        ],
      }),
    ).toThrow();
  });

  test("schemaNeedsMotionSensors spots the schemas that need a tilt sensor", () => {
    expect(
      schemaNeedsMotionSensors(gyroSchema({ type: "gyro", id: "lean" })),
    ).toBe(true);
    expect(schemaNeedsMotionSensors(GENERIC_GAMEPAD_SCHEMA)).toBe(false);
  });

  test("a session config mixing gyro and fallback schemas parses", () => {
    const config = gamepadSessionConfigSchema.parse({
      schemas: [
        {
          id: "tilt",
          name: "Tilt",
          controls: [
            { type: "gyro", id: "lean" },
            { type: "button", id: "fire", label: "Fire" },
          ],
        },
        GENERIC_GAMEPAD_SCHEMA,
      ],
    });
    expect(config.schemas.map(schemaNeedsMotionSensors)).toEqual([true, false]);
  });
});

test.describe("dpad directions", () => {
  test("codes stay 1–2 chars — they ride in every input frame", () => {
    expect(GAMEPAD_DPAD_DIRECTIONS).toHaveLength(9);
    for (const direction of GAMEPAD_DPAD_DIRECTIONS) {
      expect(direction.length).toBeLessThanOrEqual(2);
    }
  });

  test("maps all 9 directions to unit vectors (y down, diagonals normalized)", () => {
    expect(dpadToVector("c")).toEqual({ x: 0, y: 0 });
    expect(dpadToVector("u")).toEqual({ x: 0, y: -1 });
    expect(dpadToVector("d")).toEqual({ x: 0, y: 1 });
    expect(dpadToVector("l")).toEqual({ x: -1, y: 0 });
    expect(dpadToVector("r")).toEqual({ x: 1, y: 0 });
    for (const direction of GAMEPAD_DPAD_DIRECTIONS) {
      const { x, y } = dpadToVector(direction);
      const length = Math.hypot(x, y);
      expect(length).toBeCloseTo(direction === "c" ? 0 : 1, 10);
      // The vector components agree with the code's letters.
      expect(x < 0).toBe(direction.includes("l"));
      expect(x > 0).toBe(direction.includes("r"));
      expect(y < 0).toBe(direction.includes("u"));
      expect(y > 0).toBe(direction.includes("d"));
    }
  });
});

test.describe("input frames", () => {
  test("accepts buttons and normalized joysticks", () => {
    const frame = gamepadInputFrameSchema.parse({
      seq: 7,
      controls: { fire: true, stick: { x: -0.5, y: 1 } },
    });
    expect(frame.seq).toBe(7);
  });

  test("accepts single-axis and dpad values", () => {
    const frame = gamepadInputFrameSchema.parse({
      seq: 3,
      controls: {
        steer: { x: -0.25 },
        throttle: { y: 1 },
        look: "ur",
        menu: "c",
        fire: true,
      },
    });
    expect(frame.controls["steer"]).toEqual({ x: -0.25 });
    expect(frame.controls["throttle"]).toEqual({ y: 1 });
    expect(frame.controls["look"]).toBe("ur");
  });

  test("rejects out-of-range axes, bad directions and negative seq", () => {
    expect(() =>
      gamepadInputFrameSchema.parse({
        seq: 1,
        controls: { stick: { x: 2, y: 0 } },
      }),
    ).toThrow();
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { steer: { x: -2 } } }),
    ).toThrow();
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { throttle: { y: 9 } } }),
    ).toThrow();
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { look: "upwards" } }),
    ).toThrow();
    // The long-form names were replaced by the short codes.
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { look: "up-right" } }),
    ).toThrow();
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: -1, controls: {} }),
    ).toThrow();
  });
});

test.describe("physical gamepads", () => {
  test("allowPhysicalGamepad defaults to false and must be a boolean", () => {
    expect(gamepadSessionConfigSchema.parse({}).allowPhysicalGamepad).toBe(false);
    expect(
      gamepadSessionConfigSchema.parse({ allowPhysicalGamepad: true })
        .allowPhysicalGamepad,
    ).toBe(true);
    expect(() =>
      gamepadSessionConfigSchema.parse({ allowPhysicalGamepad: "yes" }),
    ).toThrow();
  });

  test("the reserved schema id cannot be used by a driver schema", () => {
    expect(() =>
      gamepadSessionConfigSchema.parse({
        schemas: [{ ...GENERIC_GAMEPAD_SCHEMA, id: PHYSICAL_GAMEPAD_SCHEMA_ID }],
      }),
    ).toThrow(/reserved/);
  });

  test("the reserved id is selectable exactly when the driver allowed it", () => {
    const off = gamepadSessionConfigSchema.parse({});
    const on = gamepadSessionConfigSchema.parse({ allowPhysicalGamepad: true });
    expect(isSelectableSchemaId(off, "generic")).toBe(true);
    expect(isSelectableSchemaId(off, PHYSICAL_GAMEPAD_SCHEMA_ID)).toBe(false);
    expect(isSelectableSchemaId(on, PHYSICAL_GAMEPAD_SCHEMA_ID)).toBe(true);
    expect(isSelectableSchemaId(on, "nope")).toBe(false);
    // One schema alone is no choice; the physical option makes it one.
    expect(hasSchemaChoice(off)).toBe(false);
    expect(hasSchemaChoice(on)).toBe(true);
  });

  test("the fixed control set has unique kebab-case ids and standard indices", () => {
    const ids = PHYSICAL_GAMEPAD_CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const buttonIndices = PHYSICAL_GAMEPAD_CONTROLS.flatMap((c) =>
      c.buttonIndex === undefined ? [] : [c.buttonIndex],
    );
    expect(new Set(buttonIndices).size).toBe(buttonIndices.length);
    // Every index is one the standard mapping defines (0–16).
    for (const i of buttonIndices) expect(i).toBeLessThanOrEqual(16);
    expect(PHYSICAL_GAMEPAD_CONTROLS.filter((c) => c.kind === "stick")).toHaveLength(2);
    expect(PHYSICAL_GAMEPAD_CONTROLS.filter((c) => c.kind === "trigger")).toHaveLength(2);
  });

  test("trigger values are analog scalars in [-1, 1]", () => {
    const frame = gamepadInputFrameSchema.parse({
      seq: 1,
      controls: { lt: 0, rt: 0.75, a: true, dpad: "c" },
    });
    expect(frame.controls["rt"]).toBe(0.75);
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { rt: 1.5 } }),
    ).toThrow();
    expect(() =>
      gamepadInputFrameSchema.parse({ seq: 1, controls: { rt: Number.NaN } }),
    ).toThrow();
  });
});

test.describe("motion controls and stream", () => {
  const withMotion = (controls: object[]) =>
    controlSchemaSchema.parse({ id: "wii", name: "Wii", controls });

  test("a motion control is just a type and an id", () => {
    const parsed = withMotion([
      { type: "motion", id: "imu" },
      { type: "button", id: "a", label: "A" },
    ]);
    expect(parsed.controls[0]).toEqual({ type: "motion", id: "imu" });
    expect(schemaNeedsMotionSensors(parsed)).toBe(true);
    expect(schemaNeedsMotionSensors(parsed)).toBe(true);
  });

  test("allows at most one motion control per schema", () => {
    expect(() =>
      withMotion([
        { type: "motion", id: "a" },
        { type: "motion", id: "b" },
      ]),
    ).toThrow();
    // Tilt and raw motion together are fine: different consumers.
    expect(
      withMotion([
        { type: "motion", id: "imu" },
        { type: "gyro", id: "lean" },
      ]).controls,
    ).toHaveLength(2);
  });

  test("samples are 7-tuples within sensor ranges", () => {
    expect(
      gamepadMotionSampleSchema.safeParse([12.5, 0, 0, 1, 0, 0, 0]).success,
    ).toBe(true);
    expect(
      gamepadMotionSampleSchema.safeParse([0, 0, 0, 1, 0, 0]).success,
    ).toBe(false);
    expect(
      gamepadMotionSampleSchema.safeParse([0, 0, 0, 99, 0, 0, 0]).success,
    ).toBe(false);
    expect(
      gamepadMotionSampleSchema.safeParse([-1, 0, 0, 1, 0, 0, 0]).success,
    ).toBe(false);
    expect(
      gamepadMotionSampleSchema.safeParse([0, 0, 0, 1, 0, 0, 9000]).success,
    ).toBe(false);
  });

  test("the player message carries 1..16 samples", () => {
    const sample = [1, 0, 0, 1, 0, 0, 0];
    const ok = gamepadPlayerClientMessageSchema.safeParse({
      type: "motion",
      samples: [sample, sample, sample],
    });
    expect(ok.success).toBe(true);
    expect(
      gamepadPlayerClientMessageSchema.safeParse({ type: "motion", samples: [] })
        .success,
    ).toBe(false);
    expect(
      gamepadPlayerClientMessageSchema.safeParse({
        type: "motion",
        samples: Array.from({ length: GAMEPAD_MOTION_BATCH_MAX + 1 }, () => sample),
      }).success,
    ).toBe(false);
  });

  test("the driver sees the same samples with the player id", () => {
    const parsed = gamepadServerMessageSchema.parse({
      type: "motion",
      playerId: "p1",
      samples: [[1, 0, 0, 1, 0, 0, 0]],
    });
    expect(parsed.type).toBe("motion");
  });
});
