/** Clamps a fader value to its [0, 1] range. */
export const clampFader = (v: number): number =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

/**
 * The value of a fader dragged `delta` px along its axis (positive = toward
 * value 1) from where the finger landed at `startValue`. The cap's center
 * travels `travel` px (track length minus the cap), so the drag is relative:
 * landing on the track does not move the cap.
 */
export const faderValueFromDelta = (
  startValue: number,
  delta: number,
  travel: number,
): number =>
  travel > 0 ? clampFader(startValue + delta / travel) : clampFader(startValue);

/**
 * Drag distance along the axis from two pointer offsets (px from the
 * control's center, y down): a vertical fader grows upward, a horizontal one
 * rightward.
 */
export const faderAxisDelta = (
  axis: "v" | "h",
  from: { dx: number; dy: number },
  to: { dx: number; dy: number },
): number => (axis === "v" ? from.dy - to.dy : to.dx - from.dx);

/** The value a fader holds after release: `default` if it springs, else as is. */
export const faderReleaseValue = (
  spring: boolean,
  defaultValue: number,
  current: number,
): number => clampFader(spring ? defaultValue : current);
