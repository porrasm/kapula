/** Next state of a toggle button after a tap. */
export const toggleNext = (current: boolean): boolean => !current;

/**
 * The stick value after release: center if the stick springs (the default,
 * `spring` undefined or true), otherwise the value where the finger lifted.
 */
export const stickReleaseValue = (
  spring: boolean | undefined,
  current: { x: number; y: number },
): { x: number; y: number } =>
  spring === false ? { x: current.x, y: current.y } : { x: 0, y: 0 };

/**
 * Where a non-relative stick measures its drag from, as a px offset from the
 * pad center. A spring stick always measures from the center (touching the
 * edge is full deflection); a non-spring stick measures from the landing
 * point shifted by the held offset, so the next touch continues without a jump.
 */
export const stickAnchor = (
  spring: boolean | undefined,
  landing: { x: number; y: number },
  held: { x: number; y: number },
): { x: number; y: number } =>
  spring === false
    ? { x: landing.x - held.x, y: landing.y - held.y }
    : { x: 0, y: 0 };
