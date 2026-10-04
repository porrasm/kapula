/** Drag distance (px) for a full knob travel (absolute) or one turn (endless). */
export const KNOB_TRAVEL_PX = 150;

/** Clamps an absolute knob value to [0, 1]. */
export const clampKnob = (v: number): number =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

/**
 * The value of an absolute knob dragged `delta` px (positive = up =
 * clockwise) from where the finger landed at `startValue`. Clamped to [0, 1].
 */
export const knobValueFromDelta = (
  startValue: number,
  delta: number,
  travel: number = KNOB_TRAVEL_PX,
): number =>
  travel > 0 ? clampKnob(startValue + delta / travel) : clampKnob(startValue);

/**
 * The cumulative turns of an endless knob dragged `delta` px (positive = up =
 * clockwise) from where the finger landed at `startTurns`. Not clamped: it
 * accumulates across drags and may go negative.
 */
export const knobTurnsFromDelta = (
  startTurns: number,
  delta: number,
  travel: number = KNOB_TRAVEL_PX,
): number =>
  Number.isFinite(startTurns) && travel > 0
    ? startTurns + delta / travel
    : Number.isFinite(startTurns)
      ? startTurns
      : 0;

/** Vertical drag in px (y down) between two pointer positions; up is positive. */
export const knobDragDelta = (fromY: number, toY: number): number =>
  fromY - toY;

/** Sweep of the absolute arc: 270°, from 7 o'clock to 5 o'clock. */
export const KNOB_ARC_DEGREES = 270;

/**
 * Pointer angle in degrees clockwise from 12 o'clock for a position
 * `fraction` (0..1) along the arc: 0 → -135° (7 o'clock), 1 → +135°.
 * Endless knobs use `turns * 360` instead.
 */
export const knobAngle = (fraction: number): number =>
  (clampKnob(fraction) - 0.5) * KNOB_ARC_DEGREES;
