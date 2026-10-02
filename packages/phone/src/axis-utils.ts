/**
 * Wire-shaping for analog values, shared by every axis producer: touch
 * joysticks (ControlWidget), tilt (gyro-utils) and real gamepads
 * (physical-gamepad-utils).
 *
 * A dragged stick or a tilting phone produces full-precision doubles, and a
 * value like 0.5836734693877551 costs 18 bytes in every frame — 30 frames a
 * second, per axis. Three decimals is finer than a thumb can aim (a full-width
 * pad is a few hundred pixels, so a step of 0.001 is well under one pixel) and
 * roughly halves an input frame.
 */
export const AXIS_DECIMALS = 3;

export const roundAxis = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const rounded = Number(v.toFixed(AXIS_DECIMALS));
  // Never emit -0: it survives JSON as 0 anyway, but keeps diffs clean.
  return rounded === 0 ? 0 : rounded;
};
