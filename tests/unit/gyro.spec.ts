import { test, expect } from "@playwright/test";
import {
  GYRO_DEADZONE,
  gyroAxisValue,
  normalizeAngleDelta,
  normalizeScreenAngle,
  tiltAngleBetween,
  tiltToAxes,
  type GyroTilt,
  type ScreenAngle,
} from "@kapula/phone/utils";

/**
 * Pure gyro math. Axis convention under test: x positive = the screen's
 * right edge tilts down, y positive = the screen's top edge tilts toward the
 * player — the same "y down" frame as on-screen joysticks — regardless of
 * how the phone is physically held (screen orientation).
 *
 * Physical scenarios are driven through rotation matrices converted to
 * spec-compliant euler readings (gamma clamped to [-90°, 90°), beta taking
 * the rest), NOT hand-written euler deltas. The deviceorientation euler
 * representation snaps between two equivalent forms when the screen crosses
 * vertical, and the original implementation — tested only with synthetic
 * euler deltas — passed its suite while jumping to full deflection on real
 * devices. These tests exist so that class of bug cannot pass silently.
 */

const RANGE = 45;
const D = Math.PI / 180;

// --- physical-orientation helpers -----------------------------------------

type Mat = number[][];

const mul = (A: Mat, B: Mat): Mat => {
  const C: Mat = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
  return C;
};

const Rx = (deg: number): Mat => {
  const c = Math.cos(deg * D);
  const s = Math.sin(deg * D);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
};
const Ry = (deg: number): Mat => {
  const c = Math.cos(deg * D);
  const s = Math.sin(deg * D);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
};
const Rz = (deg: number): Mat => {
  const c = Math.cos(deg * D);
  const s = Math.sin(deg * D);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
};

/**
 * What a spec-compliant browser reports for a physical orientation R
 * (device→world): from R = Rz(α)·Rx(β)·Ry(γ) the third row is
 * (-cosβ·sinγ, sinβ, cosβ·cosγ). Gamma is folded into (-90°, 90°) by plain
 * atan — the fold that makes readings snap between two representations of
 * one orientation when the screen crosses vertical — and beta takes the
 * full ±180° via the sign of cosβ.
 */
const readingOf = (m: Mat): GyroTilt => {
  const m31 = m[2][0];
  const m32 = m[2][1];
  const m33 = m[2][2];
  const gamma = m31 === 0 && m33 === 0 ? 0 : Math.atan(-m31 / m33);
  const cg = Math.cos(gamma);
  const cb = Math.abs(cg) > 1e-9 ? m33 / cg : -m31 / Math.sin(gamma);
  return { beta: Math.atan2(m32, cb) / D, gamma: gamma / D };
};

/**
 * Portrait phone (screen angle 0) pitched back by `pitch` degrees from flat
 * (top edge toward the player positive), then twisted `twist` degrees about
 * its own screen normal — the natural one-handed steering-wheel motion.
 */
const pitched = (pitch: number, twist = 0): Mat => mul(Rx(pitch), Rz(twist));

/** Same pose, then rolled about the device's long (y) axis by `roll` degrees. */
const rolled = (pitch: number, roll: number): Mat => mul(Rx(pitch), Ry(roll));

/**
 * Landscape hold: the phone spun -90° in its own plane (screen angle 270 —
 * screen-up along device -x), pitched back by `pitch`, with a hand twist.
 */
const landscape = (pitch: number, twist = 0): Mat =>
  mul(Rx(pitch), Rz(-90 + twist));

/** The other euler representation of the same physical orientation. */
const flipped = ({ beta, gamma }: GyroTilt): GyroTilt => ({
  beta: 180 - beta,
  gamma: gamma - 180,
});

const steps = (from: number, to: number, count: number): number[] =>
  Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);

const expectMonotonic = (values: number[], direction: 1 | -1) => {
  for (let i = 1; i < values.length; i++)
    expect((values[i] - values[i - 1]) * direction).toBeGreaterThanOrEqual(-1e-9);
};

const expectMaxStep = (values: number[], bound: number) => {
  for (let i = 1; i < values.length; i++)
    expect(Math.abs(values[i] - values[i - 1])).toBeLessThanOrEqual(bound);
};

/** Inverts the deadzone rescale: the output for a full-range tilt fraction. */
const expected = (fraction: number) =>
  (Math.sign(fraction) * (Math.abs(fraction) - GYRO_DEADZONE)) /
  (1 - GYRO_DEADZONE);

const FLAT: GyroTilt = { beta: 0, gamma: 0 };

const at = (reading: GyroTilt, neutral = FLAT, angle: ScreenAngle = 0) =>
  tiltToAxes(reading, neutral, angle, RANGE);

// --- helpers' own sanity ---------------------------------------------------

test.describe("readingOf (test harness)", () => {
  test("recovers plain single-axis euler angles", () => {
    expect(readingOf(Rx(40)).beta).toBeCloseTo(40, 10);
    expect(readingOf(Rx(40)).gamma).toBeCloseTo(0, 10);
    expect(readingOf(Ry(30)).gamma).toBeCloseTo(30, 10);
    expect(readingOf(Ry(30)).beta).toBeCloseTo(0, 10);
    // Pitch past vertical stays on beta, like the spec says.
    expect(readingOf(Rx(100)).beta).toBeCloseTo(100, 10);
  });

  test("always reports spec ranges: beta in ±180, gamma within ±90", () => {
    for (const pitch of [0, 30, 60, 85, 90, 95, 120, 170])
      for (const twist of [-30, -10, 0, 10, 30]) {
        const r = readingOf(pitched(pitch, twist));
        expect(Math.abs(r.gamma)).toBeLessThanOrEqual(90);
        expect(Math.abs(r.beta)).toBeLessThanOrEqual(180);
      }
  });

  test("reproduces the representation snap the fix must absorb", () => {
    // Pitching through vertical with a slight hand twist: the reported
    // angles jump discontinuously even though the motion is 4° of pitch.
    const before = readingOf(pitched(88, 10));
    const after = readingOf(pitched(92, 10));
    expect(Math.abs(after.gamma - before.gamma)).toBeGreaterThan(90);
    // ...while the physical orientations are genuinely 4° apart.
    expect(tiltAngleBetween(before, after)).toBeLessThan(5);
  });
});

// --- small pure helpers ----------------------------------------------------

test.describe("normalizeAngleDelta", () => {
  test("keeps small deltas and wraps across ±180", () => {
    expect(normalizeAngleDelta(0)).toBe(0);
    expect(normalizeAngleDelta(30)).toBe(30);
    expect(normalizeAngleDelta(-30)).toBe(-30);
    expect(normalizeAngleDelta(-175 - 175)).toBe(10);
    expect(normalizeAngleDelta(175 - -175)).toBe(-10);
    expect(normalizeAngleDelta(360)).toBe(0);
    expect(normalizeAngleDelta(-180)).toBe(-180);
    expect(normalizeAngleDelta(180)).toBe(-180);
  });
});

test.describe("normalizeScreenAngle", () => {
  test("maps browser-reported angles onto the four quadrants", () => {
    expect(normalizeScreenAngle(0)).toBe(0);
    expect(normalizeScreenAngle(90)).toBe(90);
    expect(normalizeScreenAngle(180)).toBe(180);
    expect(normalizeScreenAngle(270)).toBe(270);
    // Old iOS reports window.orientation = -90 for one landscape side.
    expect(normalizeScreenAngle(-90)).toBe(270);
    expect(normalizeScreenAngle(360)).toBe(0);
  });
});

test.describe("tiltAngleBetween", () => {
  test("measures the physical angle between two readings", () => {
    expect(tiltAngleBetween(FLAT, FLAT)).toBeCloseTo(0, 6);
    expect(tiltAngleBetween(FLAT, { beta: 90, gamma: 0 })).toBeCloseTo(90, 6);
    expect(tiltAngleBetween(FLAT, { beta: 0, gamma: 30 })).toBeCloseTo(30, 6);
    expect(
      tiltAngleBetween({ beta: 40, gamma: 5 }, { beta: 42, gamma: 5 }),
    ).toBeCloseTo(2, 6);
  });

  test("readings straddling the euler flip compare as the same pose", () => {
    // acos near 1 amplifies float error, so the tolerance is looser here.
    const reading: GyroTilt = { beta: 87, gamma: -72 };
    expect(tiltAngleBetween(reading, flipped(reading))).toBeCloseTo(0, 3);
  });
});

// --- axis conventions (flat neutral, exact values) -------------------------

test.describe("tiltToAxes conventions in portrait", () => {
  test("the neutral pose is centered, wherever it is", () => {
    expect(at(FLAT)).toEqual({ x: 0, y: 0 });
    const held: GyroTilt = { beta: 40, gamma: 5 };
    expect(at(held, held)).toEqual({ x: 0, y: 0 });
    // ...including a neutral calibrated past vertical.
    const upright: GyroTilt = { beta: 100, gamma: 0 };
    expect(at(upright, upright)).toEqual({ x: 0, y: 0 });
  });

  test("right edge down is +x, top edge toward the player is +y", () => {
    expect(at({ beta: 0, gamma: RANGE }).x).toBeCloseTo(1, 10);
    expect(at({ beta: 0, gamma: -RANGE }).x).toBeCloseTo(-1, 10);
    expect(at({ beta: RANGE, gamma: 0 }).y).toBeCloseTo(1, 10);
    expect(at({ beta: -RANGE, gamma: 0 }).y).toBeCloseTo(-1, 10);
    // A pure tilt keeps the other axis quiet.
    expect(at({ beta: 0, gamma: RANGE }).y).toBeCloseTo(0, 10);
    expect(at({ beta: RANGE, gamma: 0 }).x).toBeCloseTo(0, 10);
    // Half deflection scales linearly (after the deadzone rescale).
    expect(at({ beta: 0, gamma: RANGE / 2 }).x).toBeCloseTo(expected(0.5), 10);
    expect(at({ beta: RANGE / 2, gamma: 0 }).y).toBeCloseTo(expected(0.5), 10);
  });

  test("tilt beyond the range clamps to full deflection", () => {
    expect(at({ beta: 0, gamma: 89 }).x).toBeCloseTo(1, 10);
    expect(at({ beta: -90, gamma: 0 }).y).toBeCloseTo(-1, 10);
    // Pitch keeps its full range past vertical instead of folding back.
    expect(at({ beta: -135, gamma: 0 }).y).toBeCloseTo(-1, 10);
  });

  test("resting-hand jitter inside the deadzone reads as centered", () => {
    const insideDeadzone = RANGE * GYRO_DEADZONE * 0.9;
    expect(at({ beta: insideDeadzone, gamma: insideDeadzone })).toEqual({
      x: 0,
      y: 0,
    });
    // ...and output is continuous at the deadzone edge, not a jump.
    const justOutside = at({ beta: 0, gamma: RANGE * (GYRO_DEADZONE + 0.01) }).x;
    expect(justOutside).toBeGreaterThan(0);
    expect(justOutside).toBeLessThan(0.05);
  });

  test("a range option changes the tilt needed for full deflection", () => {
    const gentle = tiltToAxes({ beta: 0, gamma: 15 }, FLAT, 0, 15);
    expect(gentle.x).toBeCloseTo(1, 10);
  });

  test("pitch wrapping across ±180 stays a small tilt", () => {
    const nearFlip: GyroTilt = { beta: 175, gamma: 0 };
    const past = tiltToAxes({ beta: -175, gamma: 0 }, nearFlip, 0, RANGE);
    expect(past.y).toBeCloseTo(expected(10 / RANGE), 10);
  });
});

test.describe("tiltToAxes across screen orientations", () => {
  // The same physical gesture, expressed in device-frame angles for each way
  // of holding the phone; near-flat poses keep the axes exactly separable.
  test("'screen right edge down' is +x however the phone is held", () => {
    const reference = at({ beta: 0, gamma: 20 }, FLAT, 0);
    const equivalents: Array<[GyroTilt, ScreenAngle]> = [
      [{ beta: 20, gamma: 0 }, 90],
      [{ beta: 0, gamma: -20 }, 180],
      [{ beta: -20, gamma: 0 }, 270],
    ];
    for (const [reading, angle] of equivalents) {
      const axes = at(reading, FLAT, angle);
      expect(axes.x).toBeCloseTo(reference.x, 10);
      expect(axes.y).toBeCloseTo(reference.y, 10);
    }
    expect(reference.x).toBeGreaterThan(0);
    expect(reference.y).toBeCloseTo(0, 10);
  });

  test("'screen top toward the player' is +y however the phone is held", () => {
    const reference = at({ beta: 20, gamma: 0 }, FLAT, 0);
    const equivalents: Array<[GyroTilt, ScreenAngle]> = [
      [{ beta: 0, gamma: -20 }, 90],
      [{ beta: -20, gamma: 0 }, 180],
      [{ beta: 0, gamma: 20 }, 270],
    ];
    for (const [reading, angle] of equivalents) {
      const axes = at(reading, FLAT, angle);
      expect(axes.x).toBeCloseTo(reference.x, 10);
      expect(axes.y).toBeCloseTo(reference.y, 10);
    }
    expect(reference.x).toBeCloseTo(0, 10);
    expect(reference.y).toBeGreaterThan(0);
  });
});

// --- euler-representation robustness ---------------------------------------

test.describe("euler representation invariance", () => {
  // The browser is free to report either euler form of one physical
  // orientation, and snaps between them mid-motion. The output must not
  // depend on which form arrives — for the reading OR the neutral.
  const readings: GyroTilt[] = [
    { beta: 93, gamma: 72 },
    { beta: 80, gamma: -88 },
    { beta: 40, gamma: 5 },
    { beta: 170, gamma: 30 },
  ];
  const neutral: GyroTilt = { beta: 60, gamma: 10 };

  test("both representations of a reading produce identical axes", () => {
    for (const reading of readings)
      for (const angle of [0, 90, 180, 270] as const) {
        const a = tiltToAxes(reading, neutral, angle, RANGE);
        const b = tiltToAxes(flipped(reading), neutral, angle, RANGE);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
      }
  });

  test("both representations of the neutral produce identical axes", () => {
    for (const reading of readings) {
      const a = tiltToAxes(reading, neutral, 0, RANGE);
      const b = tiltToAxes(reading, flipped(neutral), 0, RANGE);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });
});

// --- physical continuity through the poses that used to break ---------------

test.describe("physical continuity (portrait)", () => {
  test("pitching through vertical with a hand twist keeps y smooth and x quiet", () => {
    // The reported bug: near upright, y jumped to full deflection and x
    // slammed from -1 to +1 as the euler representation snapped.
    const neutral = readingOf(pitched(75, 10));
    const sweep = steps(60, 120, 30).map((pitch) =>
      tiltToAxes(readingOf(pitched(pitch, 10)), neutral, 0, RANGE),
    );
    expectMonotonic(sweep.map((a) => a.y), 1);
    expectMaxStep(sweep.map((a) => a.y), 0.1);
    expect(sweep[0].y).toBeLessThan(-0.2);
    expect(sweep[sweep.length - 1].y).toBeGreaterThan(0.8);
    for (const { x } of sweep) expect(Math.abs(x)).toBeLessThanOrEqual(0.05);
  });

  test("steering twist near upright responds smoothly, not with noise slams", () => {
    // Old behavior: at 80° pitch a 2.5° twist read as x ≈ 0.26–0.56 and 5°
    // saturated the axis — hand jitter amplified by the 1/cos(beta) pole.
    const neutral = readingOf(pitched(80));
    const twists = steps(-30, 30, 24);
    const sweep = twists.map((twist) =>
      tiltToAxes(readingOf(pitched(80, twist)), neutral, 0, RANGE),
    );
    expectMonotonic(sweep.map((a) => a.x), -1);
    expectMaxStep(sweep.map((a) => a.x), 0.2);
    const atTwist = (twist: number) => sweep[twists.indexOf(twist)];
    expect(Math.abs(atTwist(2.5).x)).toBeLessThan(0.15);
    expect(Math.abs(atTwist(-2.5).x)).toBeLessThan(0.15);
    // ...while a deliberate 30° twist still reaches full deflection.
    expect(atTwist(-30).x).toBeGreaterThan(0.9);
    expect(atTwist(30).x).toBeLessThan(-0.9);
    for (const { y } of sweep) expect(Math.abs(y)).toBeLessThanOrEqual(0.05);
  });

  test("rolling at a comfortable pitch keeps the familiar steering feel", () => {
    const neutral = readingOf(rolled(40, 0));
    const rolls = steps(-60, 60, 24);
    const sweep = rolls.map((roll) =>
      tiltToAxes(readingOf(rolled(40, roll)), neutral, 0, RANGE),
    );
    expectMonotonic(sweep.map((a) => a.x), 1);
    expectMaxStep(sweep.map((a) => a.x), 0.15);
    // The roll gain keeps "degrees of physical roll" ≈ "degrees of reading"
    // at held-in-hands pitches, so range semantics stay honest...
    const atRoll = (roll: number) => sweep[rolls.indexOf(roll)];
    expect(atRoll(20).x).toBeCloseTo(expected(20 / RANGE), 1);
    expect(atRoll(-20).x).toBeCloseTo(expected(-20 / RANGE), 1);
    // ...and full deflection stays reachable without heroic wrist angles.
    expect(atRoll(45).x).toBeGreaterThan(0.9);
    expect(atRoll(-45).x).toBeLessThan(-0.9);
  });

  test("a neutral calibrated past vertical still gives gentle forward y", () => {
    // The literal report: with the phone held just past vertical, a small
    // forward tilt made y skip every value between 0 and -1.
    const neutral = readingOf(pitched(95, 10));
    const pitches = steps(95, 55, 40);
    const sweep = pitches.map((pitch) =>
      tiltToAxes(readingOf(pitched(pitch, 10)), neutral, 0, RANGE),
    );
    expectMonotonic(sweep.map((a) => a.y), -1);
    expectMaxStep(sweep.map((a) => a.y), 0.1);
    const nearNeutral = sweep[pitches.indexOf(90)];
    expect(nearNeutral.y).toBeLessThan(0);
    expect(nearNeutral.y).toBeGreaterThan(-0.2);
  });
});

test.describe("physical continuity (landscape)", () => {
  test("pitching through vertical keeps y smooth and x quiet", () => {
    // Landscape play near upright sits right on gamma's ±90° clamp; the old
    // per-angle deltas flipped y by ~180° of gamma there.
    const neutral = readingOf(landscape(75, 10));
    const sweep = steps(60, 120, 30).map((pitch) =>
      tiltToAxes(readingOf(landscape(pitch, 10)), neutral, 270, RANGE),
    );
    expectMonotonic(sweep.map((a) => a.y), 1);
    expectMaxStep(sweep.map((a) => a.y), 0.1);
    expect(sweep[0].y).toBeLessThan(-0.2);
    expect(sweep[sweep.length - 1].y).toBeGreaterThan(0.8);
    for (const { x } of sweep) expect(Math.abs(x)).toBeLessThanOrEqual(0.05);
  });
});

// --- wire shape -------------------------------------------------------------

test.describe("gyroAxisValue", () => {
  test("full sends both axes, single-axis modes only their own", () => {
    const axes = { x: 0.25, y: -0.5 };
    expect(gyroAxisValue("full", axes)).toEqual({ x: 0.25, y: -0.5 });
    expect(gyroAxisValue("x", axes)).toEqual({ x: 0.25 });
    expect(gyroAxisValue("y", axes)).toEqual({ y: -0.5 });
  });
});
