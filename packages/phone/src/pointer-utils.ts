import type { ScreenAngle } from "./gyro-utils.js";
import { rotateDelta } from "./orientation-utils.js";

type Rect = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

/**
 * A pointer position, as an offset from a control's center in the control's
 * own (untransformed) pixels. Touch controls get client coordinates, but sit
 * inside surfaces that CSS may have rotated (the oriented surface) or scaled
 * (the help page's demo): the bounding rect is the axis-aligned box of the
 * transformed control, whose center is still the control's center; the
 * offset from it is rotated back and divided by the scale.
 */
export const pointerDeltaInFrame = (
  rect: Rect,
  size: Size,
  synthetic: ScreenAngle,
  clientX: number,
  clientY: number,
): { dx: number; dy: number } => {
  const rotated = rotateDelta(
    clientX - (rect.left + rect.width / 2),
    clientY - (rect.top + rect.height / 2),
    synthetic,
  );
  // A quarter turn swaps which local side spans the rect's width.
  const spansWidth = synthetic % 180 === 0 ? size.width : size.height;
  const scale = spansWidth > 0 && rect.width > 0 ? rect.width / spansWidth : 1;
  return { dx: rotated.dx / scale, dy: rotated.dy / scale };
};
