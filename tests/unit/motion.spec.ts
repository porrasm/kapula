import { test, expect } from "@playwright/test";
import {
  MOTION_BATCH_SIZE,
  STANDARD_GRAVITY,
  createAccelSignEstimator,
  encodeMotionSample,
  expectedReaction,
  readMotionEvent,
} from "@kapula/phone/utils";
import {
  GAMEPAD_MOTION_ACCEL_MAX_G,
  GAMEPAD_MOTION_BATCH_MAX,
  gamepadMotionSampleSchema,
} from "@kapula/protocol";

const FLAT_UP = { beta: 0, gamma: 0 };

test.describe("readMotionEvent", () => {
  test("maps the event's fields onto device x, y, z", () => {
    const raw = readMotionEvent({
      timeStamp: 1234.5,
      accelerationIncludingGravity: { x: 0.1, y: 0.2, z: 9.8 },
      rotationRate: { alpha: 3, beta: 1, gamma: 2 },
    });
    expect(raw).toEqual({
      t: 1234.5,
      accel: [0.1, 0.2, 9.8],
      // Rate about x is beta, about y gamma, about z alpha.
      rate: [1, 2, 3],
    });
  });

  test("a sensorless event (nulls) yields nothing; a missing rotation rate reads as still", () => {
    expect(
      readMotionEvent({
        timeStamp: 1,
        accelerationIncludingGravity: { x: null, y: null, z: null },
        rotationRate: null,
      }),
    ).toBeNull();
    expect(
      readMotionEvent({
        timeStamp: 1,
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        rotationRate: null,
      })?.rate,
    ).toEqual([0, 0, 0]);
  });
});

test.describe("encodeMotionSample", () => {
  test("converts to g and deg/s, rounded, in the wire tuple order", () => {
    const sample = encodeMotionSample(
      {
        t: 100.04,
        accel: [0, STANDARD_GRAVITY / 2, STANDARD_GRAVITY],
        rate: [10.004, -20.006, 359.999],
      },
      1,
    );
    expect(sample).toEqual([100, 0, 0.5, 1, 10, -20.01, 360]);
    expect(gamepadMotionSampleSchema.safeParse(sample).success).toBe(true);
  });

  test("an inverted accelerometer is flipped to the spec sign", () => {
    const sample = encodeMotionSample(
      { t: 0, accel: [0, 0, -STANDARD_GRAVITY], rate: [0, 0, 0] },
      -1,
    );
    expect(sample[3]).toBe(1);
  });

  test("garbage readings clamp into the schema's range instead of failing validation", () => {
    const sample = encodeMotionSample(
      { t: -5, accel: [1e6, 0, 0], rate: [0, -1e6, 0] },
      1,
    );
    expect(sample[0]).toBe(0);
    expect(sample[1]).toBe(GAMEPAD_MOTION_ACCEL_MAX_G);
    expect(gamepadMotionSampleSchema.safeParse(sample).success).toBe(true);
  });

  test("a batch never exceeds what one message may carry", () => {
    expect(MOTION_BATCH_SIZE).toBeLessThanOrEqual(GAMEPAD_MOTION_BATCH_MAX);
  });
});

test.describe("expectedReaction", () => {
  test("a flat, screen-up phone expects +1 on z", () => {
    const [x, y, z] = expectedReaction(FLAT_UP);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  test("standing the phone up on its bottom edge moves the reaction to +y", () => {
    const [, y, z] = expectedReaction({ beta: 90, gamma: 0 });
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });
});

test.describe("accelerometer sign estimation", () => {
  const up = expectedReaction(FLAT_UP);

  test("a spec-compliant sensor settles on +1 after a few still samples", () => {
    const estimator = createAccelSignEstimator();
    for (let i = 0; i < 3; i++) {
      estimator.observe([0.05, -0.02, STANDARD_GRAVITY], up);
      expect(estimator.sign).toBeNull();
    }
    estimator.observe([0, 0, STANDARD_GRAVITY], up);
    expect(estimator.sign).toBe(1);
  });

  test("an inverted sensor (iOS) settles on -1", () => {
    const estimator = createAccelSignEstimator();
    for (let i = 0; i < 4; i++) {
      estimator.observe([0, 0, -STANDARD_GRAVITY], up);
    }
    expect(estimator.sign).toBe(-1);
  });

  test("samples taken while the phone is being swung do not count", () => {
    const estimator = createAccelSignEstimator();
    for (let i = 0; i < 10; i++) {
      estimator.observe([0, 0, 3 * STANDARD_GRAVITY], up);
      estimator.observe([0, 0, 0.2 * STANDARD_GRAVITY], up);
    }
    expect(estimator.sign).toBeNull();
  });

  test("a decision is final", () => {
    const estimator = createAccelSignEstimator();
    for (let i = 0; i < 4; i++) estimator.observe([0, 0, STANDARD_GRAVITY], up);
    for (let i = 0; i < 10; i++) estimator.observe([0, 0, -STANDARD_GRAVITY], up);
    expect(estimator.sign).toBe(1);
  });

  test("agreement is judged against the orientation sensor, not a fixed axis", () => {
    // Phone standing on its bottom edge: gravity's reaction is along +y, and
    // an accelerometer reporting exactly that is spec-compliant.
    const standing = expectedReaction({ beta: 90, gamma: 0 });
    const estimator = createAccelSignEstimator();
    for (let i = 0; i < 4; i++) estimator.observe([0, STANDARD_GRAVITY, 0], standing);
    expect(estimator.sign).toBe(1);
  });
});
