import type { GamepadGyroMode, GamepadInputValue } from "@kapula/protocol";
import { roundAxis } from "./axis-utils.js";

/**
 * Pure gyro math: turns raw deviceorientation tilt (beta/gamma) into the
 * normalized virtual-joystick axes the wire protocol carries. Kept free of
 * React and the DOM so unit tests can drive it with synthetic readings.
 *
 * Only the gravity-referenced tilt angles are used — beta (pitch, rotation
 * about the device's x-axis) and gamma (roll, rotation about its y-axis).
 * Alpha (yaw) needs the compass and drifts, so it is deliberately excluded
 * from the protocol.
 *
 * The angles are never differenced directly: the euler representation is
 * degenerate near the upright pose (gamma is clamped to (-90°, 90°), so the
 * same physical orientation has two representations that the browser snaps
 * between when the screen crosses vertical, and gamma's sensitivity blows up
 * as 1/cos(beta)). Instead every reading is converted to the device-frame
 * gravity direction — identical for both representations, and a continuous
 * function of the physical orientation — and tilt is measured from that.
 *
 * Output convention matches on-screen joysticks (y positive downwards):
 * - x positive: the screen's right edge tilts down
 * - y positive: the screen's top edge tilts toward the player (pulling back);
 *   pushing the top away is negative, like pushing a stick forward.
 */

export type GyroTilt = { beta: number; gamma: number };

/** Fraction of full deflection treated as centered, to keep a resting hand quiet. */
export const GYRO_DEADZONE = 0.06;

const RAD = Math.PI / 180;

/** Wraps an angle difference into [-180, 180) so pitch crossing ±180 stays continuous. */
export const normalizeAngleDelta = (delta: number): number => {
  const wrapped = ((delta % 360) + 540) % 360;
  return wrapped - 180;
};

export type ScreenAngle = 0 | 90 | 180 | 270;

/** Coerces whatever the browser reports (including iOS's -90) onto the 4 quadrants. */
export const normalizeScreenAngle = (angle: number): ScreenAngle => {
  const wrapped = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return wrapped as ScreenAngle;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Deadzone with rescaling, so output stays continuous at the deadzone edge. */
const applyDeadzone = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude < GYRO_DEADZONE) return 0;
  return (Math.sign(value) * (magnitude - GYRO_DEADZONE)) / (1 - GYRO_DEADZONE);
};

/**
 * The gravity direction ("down") in device coordinates, from the euler pair.
 * With the spec's R = Rz(alpha)·Rx(beta)·Ry(gamma), the world down vector
 * pulled into the device frame is Rᵀ·(0,0,-1) — alpha drops out. Both euler
 * representations of one physical orientation ((β,γ) and (180°−β, γ−180°))
 * give the same vector, which is what makes everything downstream continuous.
 */
export const gravityOf = ({ beta, gamma }: GyroTilt): [number, number, number] => {
  const b = beta * RAD;
  const g = gamma * RAD;
  return [Math.cos(b) * Math.sin(g), -Math.sin(b), -Math.cos(b) * Math.cos(g)];
};

/**
 * Angle in degrees between the physical orientations of two readings (via
 * their gravity directions). Robust where naive per-angle comparison lies:
 * readings straddling the euler flip compare equal here.
 */
export const tiltAngleBetween = (a: GyroTilt, b: GyroTilt): number => {
  const [ax, ay, az] = gravityOf(a);
  const [bx, by, bz] = gravityOf(b);
  return Math.acos(clamp(ax * bx + ay * by + az * bz, -1, 1)) / RAD;
};

/**
 * Pitch/roll of the *screen* relative to gravity, in degrees. The screen
 * basis is the device basis rotated by the screen-orientation angle, so
 * rotating the phone into landscape must not turn steering into throttle.
 *
 * - pitch: atan2 over the screen's y-z gravity components — full ±180°
 *   range, continuous as the screen pitches through vertical (the gesture
 *   that made raw euler deltas jump to full deflection).
 * - roll: asin of the gravity component along screen-x — bounded ±90°,
 *   continuous everywhere, and naturally insensitive to rotation about
 *   gravity (which no gravity-only scheme can observe).
 */
const poseOf = (
  reading: GyroTilt,
  screenAngle: ScreenAngle,
): { pitch: number; roll: number } => {
  const [dx, dy, dz] = gravityOf(reading);
  const a = screenAngle * RAD;
  const sx = Math.cos(a) * dx - Math.sin(a) * dy;
  const sy = Math.sin(a) * dx + Math.cos(a) * dy;
  return {
    pitch: Math.atan2(-sy, -dz) / RAD,
    roll: Math.asin(clamp(sx, -1, 1)) / RAD,
  };
};

/**
 * The projected roll reading shrinks with cos(pitch) — a phone pitched up
 * toward vertical needs ever larger physical rolls for the same value — so
 * roll is boosted by the neutral pose's shortfall to keep steering feel
 * pitch-independent. The boost is capped at the 70°-pitch level: beyond
 * that, steering fades gracefully instead of amplifying sensor noise the
 * way raw gamma's 1/cos(beta) singularity did.
 */
const MIN_ROLL_REFERENCE = Math.cos(70 * RAD);

/**
 * Maps a tilt reading, relative to the calibrated neutral pose, onto screen
 * axes. `range` is the tilt in degrees from neutral that counts as full
 * deflection.
 */
export const tiltToAxes = (
  reading: GyroTilt,
  neutral: GyroTilt,
  screenAngle: ScreenAngle,
  range: number,
): { x: number; y: number } => {
  const pose = poseOf(reading, screenAngle);
  const zero = poseOf(neutral, screenAngle);
  const rollGain = 1 / Math.max(Math.cos(zero.pitch * RAD), MIN_ROLL_REFERENCE);
  // Roll is bounded to ±90° so its delta never wraps; pitch spans ±180° and
  // needs the wrap so a fully inverted phone stays continuous.
  const x = ((pose.roll - zero.roll) * rollGain) / range;
  const y = normalizeAngleDelta(pose.pitch - zero.pitch) / range;
  return {
    x: applyDeadzone(clamp(x, -1, 1)),
    y: applyDeadzone(clamp(y, -1, 1)),
  };
};

/**
 * Like single-axis joysticks, single-axis gyro modes send only their own
 * axis. Tilt rides the ~30 fps throttle like a dragged stick, so the values
 * are rounded here — the one place every gyro frame passes through.
 */
export const gyroAxisValue = (
  mode: GamepadGyroMode,
  axes: { x: number; y: number },
): GamepadInputValue => {
  const x = roundAxis(axes.x);
  const y = roundAxis(axes.y);
  return mode === "x" ? { x } : mode === "y" ? { y } : { x, y };
};
