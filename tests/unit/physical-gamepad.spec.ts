import { test, expect } from "@playwright/test";
import {
  gamepadInputFrameSchema,
  PHYSICAL_GAMEPAD_CONTROLS,
} from "@kapula/protocol";
import {
  applyStickDeadzone,
  diffPhysicalControls,
  dpadDirection,
  IDLE_PHYSICAL_GAMEPAD,
  pickGamepad,
  readPhysicalGamepad,
  samePhysicalControls,
  STICK_DEADZONE,
  type GamepadReading,
} from "@kapula/phone/utils";

/** A standard-mapping reading with every button released and sticks centered. */
const idle = (): { buttons: { pressed: boolean; value: number }[]; axes: number[] } => ({
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  axes: [0, 0, 0, 0],
});

const press = (reading: ReturnType<typeof idle>, index: number, value = 1) => {
  reading.buttons[index] = { pressed: value > 0, value };
  return reading;
};

test.describe("readPhysicalGamepad", () => {
  test("idle reading maps every control to its released state", () => {
    const controls = readPhysicalGamepad(idle());
    expect(Object.keys(controls).sort()).toEqual(
      PHYSICAL_GAMEPAD_CONTROLS.map((c) => c.id).sort(),
    );
    expect(controls["left-stick"]).toEqual({ x: 0, y: 0 });
    expect(controls["right-stick"]).toEqual({ x: 0, y: 0 });
    expect(controls["dpad"]).toBe("c");
    expect(controls["a"]).toBe(false);
    expect(controls["lt"]).toBe(0);
    expect(controls["rt"]).toBe(0);
    expect(controls).toEqual(IDLE_PHYSICAL_GAMEPAD);
  });

  test("a missing or short controller reads as idle, never as garbage", () => {
    expect(readPhysicalGamepad({ buttons: [], axes: [] })).toEqual(
      IDLE_PHYSICAL_GAMEPAD,
    );
    expect(
      readPhysicalGamepad({ buttons: [{ pressed: true, value: 1 }], axes: [0.5] })
        ["a"],
    ).toBe(true);
  });

  test("buttons, sticks, triggers and the dpad map per the standard layout", () => {
    const reading = idle();
    press(reading, 0); // a
    press(reading, 5); // rb
    press(reading, 7, 0.25); // rt analog
    press(reading, 16); // home
    reading.axes = [0.5, -0.5, -1, 1];
    const controls = readPhysicalGamepad(reading);
    expect(controls["a"]).toBe(true);
    expect(controls["b"]).toBe(false);
    expect(controls["rb"]).toBe(true);
    expect(controls["rt"]).toBe(0.25);
    expect(controls["home"]).toBe(true);
    const left = controls["left-stick"] as { x: number; y: number };
    expect(left.x).toBeGreaterThan(0.3);
    expect(left.y).toBeLessThan(-0.3);
    expect(left.x).toBeCloseTo(-left.y, 5);
    // Full diagonal deflection is clamped to the unit circle.
    const right = controls["right-stick"] as { x: number; y: number };
    expect(Math.hypot(right.x, right.y)).toBeLessThanOrEqual(1.0001);
    expect(right.x).toBeLessThan(0);
    expect(right.y).toBeGreaterThan(0);
  });

  test("every mapped frame passes the wire schema", () => {
    const reading = idle();
    press(reading, 6, 0.999);
    press(reading, 12);
    press(reading, 15);
    reading.axes = [0.123456, 0.9, -0.2, 0.05];
    const frame = gamepadInputFrameSchema.safeParse({
      seq: 1,
      controls: readPhysicalGamepad(reading),
    });
    expect(frame.success).toBe(true);
    // Out-of-range or NaN axes never leak past the mapping.
    const wild = idle();
    wild.axes = [5, Number.NaN, -3, Number.POSITIVE_INFINITY];
    press(wild, 7, 4);
    expect(
      gamepadInputFrameSchema.safeParse({
        seq: 2,
        controls: readPhysicalGamepad(wild),
      }).success,
    ).toBe(true);
  });

  test("digital-only triggers report 1 when pressed without an analog value", () => {
    const reading = idle();
    reading.buttons[6] = { pressed: true, value: 0 };
    expect(readPhysicalGamepad(reading)["lt"]).toBe(1);
  });
});

test.describe("dpadDirection", () => {
  const withDpad = (...indices: number[]): GamepadReading => {
    const reading = idle();
    for (const i of indices) press(reading, i);
    return reading;
  };

  test("maps the four buttons and their diagonals", () => {
    expect(dpadDirection(withDpad())).toBe("c");
    expect(dpadDirection(withDpad(12))).toBe("u");
    expect(dpadDirection(withDpad(13))).toBe("d");
    expect(dpadDirection(withDpad(14))).toBe("l");
    expect(dpadDirection(withDpad(15))).toBe("r");
    expect(dpadDirection(withDpad(12, 15))).toBe("ur");
    expect(dpadDirection(withDpad(13, 14))).toBe("dl");
  });

  test("opposite buttons cancel like a hat switch", () => {
    expect(dpadDirection(withDpad(12, 13))).toBe("c");
    expect(dpadDirection(withDpad(14, 15, 12))).toBe("u");
  });
});

test.describe("applyStickDeadzone", () => {
  test("rest wobble inside the deadzone reads as centered", () => {
    expect(applyStickDeadzone(0.03, -0.05)).toEqual({ x: 0, y: 0 });
    expect(applyStickDeadzone(STICK_DEADZONE, 0)).toEqual({ x: 0, y: 0 });
  });

  test("rescales so the edge of the deadzone is 0 and full travel is 1", () => {
    expect(applyStickDeadzone(1, 0)).toEqual({ x: 1, y: 0 });
    expect(applyStickDeadzone(0, -1)).toEqual({ x: 0, y: -1 });
    const half = applyStickDeadzone(0.55, 0);
    expect(half.x).toBeCloseTo((0.55 - STICK_DEADZONE) / (1 - STICK_DEADZONE), 2);
  });

  test("rounds to three decimals and never emits -0", () => {
    const v = applyStickDeadzone(0.123456789, -0.0000001);
    expect(v.x).toBe(Number(v.x.toFixed(3)));
    expect(Object.is(v.y, -0)).toBe(false);
  });
});

test.describe("diffPhysicalControls", () => {
  test("splits edges from movement and skips unchanged controls", () => {
    const next = { ...IDLE_PHYSICAL_GAMEPAD, a: true, dpad: "u" as const, lt: 0.5 };
    next["left-stick"] = { x: 0.2, y: 0 };
    const diff = diffPhysicalControls(IDLE_PHYSICAL_GAMEPAD, next);
    expect(diff.immediate.sort()).toEqual(["a", "dpad"]);
    expect(diff.throttled.sort()).toEqual(["left-stick", "lt"]);
    expect(diffPhysicalControls(next, next)).toEqual({ immediate: [], throttled: [] });
  });

  test("a first reading against nothing reports everything", () => {
    const diff = diffPhysicalControls({}, IDLE_PHYSICAL_GAMEPAD);
    expect(diff.immediate.length + diff.throttled.length).toBe(
      PHYSICAL_GAMEPAD_CONTROLS.length,
    );
  });

  test("samePhysicalControls agrees with an empty diff", () => {
    const moved = { ...IDLE_PHYSICAL_GAMEPAD, "right-stick": { x: 0, y: 0.4 } };
    expect(samePhysicalControls(IDLE_PHYSICAL_GAMEPAD, IDLE_PHYSICAL_GAMEPAD)).toBe(true);
    expect(samePhysicalControls(IDLE_PHYSICAL_GAMEPAD, moved)).toBe(false);
    expect(samePhysicalControls({}, IDLE_PHYSICAL_GAMEPAD)).toBe(false);
  });
});

test.describe("pickGamepad", () => {
  test("prefers a standard-mapping controller and skips empty slots", () => {
    const odd = { mapping: "", id: "odd" };
    const standard = { mapping: "standard", id: "std" };
    expect(pickGamepad([null, odd, standard])).toBe(standard);
    expect(pickGamepad([null, odd])).toBe(odd);
    expect(pickGamepad([null, null])).toBeNull();
    expect(pickGamepad([])).toBeNull();
  });
});
