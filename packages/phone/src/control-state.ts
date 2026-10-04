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
