import { KAPULA_RAW_MAX_TOUCHES, type KapulaRawTouch } from "@kapula/protocol";
import { AXIS_DECIMALS } from "./axis-utils.js";

/**
 * Pure bookkeeping for a `raw` control (RawTouchSurface.tsx): which finger
 * holds which slot id, and where each finger is in the controller box.
 */

/**
 * The slot a new finger gets: the lowest id no other finger holds, so ids
 * stay small and a lifted finger's id is reused by the next one. Null when
 * every slot is taken (the extra finger is ignored until one lifts).
 */
export const allocateTouchSlot = (taken: Iterable<number>): number | null => {
  const used = new Set(taken);
  for (let id = 0; id < KAPULA_RAW_MAX_TOUCHES; id++) {
    if (!used.has(id)) return id;
  }
  return null;
};

const roundUnit = (v: number): number => {
  const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return Number(clamped.toFixed(AXIS_DECIMALS));
};

/**
 * A finger's offset from the box center (in the box's own pixels, as
 * `pointerDeltaInFrame` gives it) as the wire position: 0–1 from the box's
 * left / top edge, clamped to the box — a captured finger dragged past the
 * edge sits on it — and rounded like every other analog value.
 */
export const touchPosition = (
  dx: number,
  dy: number,
  width: number,
  height: number,
): { x: number; y: number } => ({
  x: roundUnit(width > 0 ? dx / width + 0.5 : 0.5),
  y: roundUnit(height > 0 ? dy / height + 0.5 : 0.5),
});

/** The wire value: every finger down, in slot order. */
export const touchesValue = (
  touches: Iterable<KapulaRawTouch>,
): KapulaRawTouch[] =>
  [...touches]
    .map(({ id, x, y }) => ({ id, x, y }))
    .sort((a, b) => a.id - b.id);
