import {
  GAMEPAD_MOTION_ACCEL_MAX_G,
  GAMEPAD_MOTION_RATE_MAX_DPS,
  type GamepadMotionSample,
} from "@kapula/protocol";
import { gravityOf, type GyroTilt } from "./gyro-utils.js";

/**
 * Pure side of the raw motion stream (`motion` controls): turning
 * devicemotion readings into wire samples with a platform-independent sign
 * convention. The browser subscription and batching live in
 * useMotionStream.ts.
 *
 * The one thing that gets "normalized" here is the accelerometer's sign.
 * The spec says accelerationIncludingGravity is the reaction force — a phone
 * lying flat reads +9.81 on z — but iOS Safari has always reported the
 * opposite sign, and the difference would silently invert tilt-from-accel
 * for every driver. Rather than trust a user-agent sniff, the sign is
 * measured: the deviceorientation angles give the gravity direction in the
 * device frame independently, and a few quasi-static samples decide which
 * way the accelerometer points relative to it.
 */

export const STANDARD_GRAVITY = 9.80665;

/** Sensor events batched per `motion` message (at ~60 Hz: ~20 messages/s). */
export const MOTION_BATCH_SIZE = 3;

/** Latest a partial batch waits before going out, so a quiet sensor still streams. */
export const MOTION_FLUSH_MS = 50;

/** How long the sign estimate may hold up the first samples before the spec sign is assumed. */
export const MOTION_SIGN_TIMEOUT_MS = 600;

export type Vec3 = [number, number, number];

/** A devicemotion reading, in the browser's units (m/s², deg/s). */
export type RawMotion = {
  /** Event timestamp, ms. */
  t: number;
  /** accelerationIncludingGravity, device frame, browser sign. */
  accel: Vec3;
  /** Angular rate about device x, y, z (the event's beta, gamma, alpha). */
  rate: Vec3;
};

type MotionEventLike = {
  timeStamp: number;
  accelerationIncludingGravity: {
    x: number | null;
    y: number | null;
    z: number | null;
  } | null;
  rotationRate: {
    alpha: number | null;
    beta: number | null;
    gamma: number | null;
  } | null;
};

/** Null when the event carries no usable IMU data (sensorless desktops fire empties). */
export const readMotionEvent = (e: MotionEventLike): RawMotion | null => {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.y === null || a.z === null) return null;
  const r = e.rotationRate;
  return {
    t: e.timeStamp,
    accel: [a.x, a.y, a.z],
    rate: [r?.beta ?? 0, r?.gamma ?? 0, r?.alpha ?? 0],
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** Wire form: g and deg/s, rounded to what the sensors resolve, sign normalized. */
export const encodeMotionSample = (
  raw: RawMotion,
  accelSign: 1 | -1,
): GamepadMotionSample => {
  const g = (v: number) =>
    round(
      clamp(
        (accelSign * v) / STANDARD_GRAVITY,
        -GAMEPAD_MOTION_ACCEL_MAX_G,
        GAMEPAD_MOTION_ACCEL_MAX_G,
      ),
      4,
    );
  const dps = (v: number) =>
    round(
      clamp(v, -GAMEPAD_MOTION_RATE_MAX_DPS, GAMEPAD_MOTION_RATE_MAX_DPS),
      2,
    );
  return [
    Math.max(0, round(raw.t, 1)),
    g(raw.accel[0]),
    g(raw.accel[1]),
    g(raw.accel[2]),
    dps(raw.rate[0]),
    dps(raw.rate[1]),
    dps(raw.rate[2]),
  ];
};

/**
 * The reaction-force direction ("up", unit length) in the device frame for
 * an orientation reading — what a spec-compliant accelerometer reports at
 * rest, divided by g.
 */
export const expectedReaction = (tilt: GyroTilt): Vec3 => {
  const [x, y, z] = gravityOf(tilt);
  return [-x, -y, -z];
};

/** Quasi-static window: |a| this close to 1 g means the phone is not being swung. */
const STATIC_MIN_G = 0.75;
const STATIC_MAX_G = 1.25;

/** Agreement magnitude (sum of cosines) that settles the sign: four clean samples. */
const DECISIVE_AGREEMENT = 3.5;

export type AccelSignEstimator = {
  /** +1 for spec sign, -1 for inverted; null while undecided. */
  readonly sign: 1 | -1 | null;
  /** Feeds one accelerometer reading (m/s²) with the orientation-derived up direction. */
  observe: (accel: Vec3, expectedUp: Vec3) => void;
};

/**
 * Decides the accelerometer's sign from how its readings line up with the
 * orientation sensor's gravity. Only near-1 g readings count (a swung phone
 * has no clean gravity), and the decision needs several agreeing samples so
 * a single noisy one cannot lock in the wrong sign.
 */
export const createAccelSignEstimator = (): AccelSignEstimator => {
  let agreement = 0;
  let sign: 1 | -1 | null = null;
  return {
    get sign() {
      return sign;
    },
    observe(accel, expectedUp) {
      if (sign !== null) return;
      const magnitude = Math.hypot(...accel) / STANDARD_GRAVITY;
      if (magnitude < STATIC_MIN_G || magnitude > STATIC_MAX_G) return;
      const [ax, ay, az] = accel;
      const [ux, uy, uz] = expectedUp;
      const cosine = (ax * ux + ay * uy + az * uz) / (magnitude * STANDARD_GRAVITY);
      agreement += cosine;
      if (Math.abs(agreement) >= DECISIVE_AGREEMENT) sign = agreement > 0 ? 1 : -1;
    },
  };
};
