import type { ControlSchema } from "@kapula/protocol";

/** Joystick movement is coalesced to ~30 frames/s; button edges flush now. */
export const THROTTLE_MS = 33;

/**
 * Fast schemas coalesce at ~60 frames/s instead: a cursor or a fader riding
 * a CC at 30 fps visibly stutters, and the server's 120 frames/s cap leaves
 * room.
 */
export const POINTER_THROTTLE_MS = 16;

/**
 * The throttle for a schema: fast if it says `rate: "fast"` or has a pointer
 * surface (`raw`, `touchpad`), else standard.
 */
export const inputThrottleMs = (
  schema: Pick<ControlSchema, "rate" | "controls">,
): number =>
  schema.rate === "fast" ||
  schema.controls.some((c) => c.type === "raw" || c.type === "touchpad")
    ? POINTER_THROTTLE_MS
    : THROTTLE_MS;
