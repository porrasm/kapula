/** Two pointerups at most this far apart in time make a double-tap. */
export const DOUBLE_TAP_MS = 300;
/** ...and at most this far apart on screen (px, straight-line distance). */
export const DOUBLE_TAP_PX = 12;
/** Drag multiplier while a second finger holds fine mode. */
export const FINE_SCALE = 0.1;

export type TapPoint = { time: number; x: number; y: number };

/** Whether `next` completes a double-tap that began with `prev`. */
export const isDoubleTap = (
  prev: TapPoint | null,
  next: TapPoint,
  maxMs: number = DOUBLE_TAP_MS,
  maxPx: number = DOUBLE_TAP_PX,
): boolean => {
  if (!prev) return false;
  const dt = next.time - prev.time;
  if (dt < 0 || dt > maxMs) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= maxPx;
};

/**
 * Feeds one pointerup into the detector: `double` says whether it completed
 * a double-tap, `last` is the tap to remember. A double-tap consumes both
 * taps, so a third quick tap starts over instead of firing again.
 */
export const registerTap = (
  prev: TapPoint | null,
  next: TapPoint,
): { double: boolean; last: TapPoint | null } =>
  isDoubleTap(prev, next)
    ? { double: true, last: null }
    : { double: false, last: next };

/** The drag multiplier: `FINE_SCALE` only while the modifier finger is down. */
export const fineScale = (fine: boolean): number => (fine ? FINE_SCALE : 1);

/** A drag distance scaled for fine mode. */
export const scaleDragDelta = (delta: number, fine: boolean): number =>
  delta * fineScale(fine);
