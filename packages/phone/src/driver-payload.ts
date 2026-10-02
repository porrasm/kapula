/**
 * Conventions for the driver → player `message` relay. The server never looks
 * inside the payload (it is an opaque relay by design), so these are pure
 * client-side conventions a driver opts into by sending the right shape;
 * anything else is delivered and ignored.
 *
 * - `{ vibrateMs: number }` — buzz the phone, and the controller too when the
 *   player is bridging a real gamepad.
 * - `{ text: string }` — show a line in the in-game header for a few seconds
 *   ("You are Red", a score, "Press A to respawn"). `{ text: null }` clears
 *   it at once. Longer text is truncated rather than dropped: a driver that
 *   sends a paragraph should still see something useful on the phone.
 */
export const DRIVER_TEXT_MAX_LENGTH = 64;
/** How long a text line stays up when the driver does not clear it. */
export const DRIVER_TEXT_MS = 4000;
/** Guards against a stuck motor; the browser caps this anyway. */
export const DRIVER_VIBRATE_MAX_MS = 1000;

export type DriverPayload = {
  /** Milliseconds to buzz, already clamped; null when not requested. */
  vibrateMs: number | null;
  /** A string to show, null to clear, undefined when the key is absent. */
  text: string | null | undefined;
};

export const parseDriverPayload = (payload: unknown): DriverPayload => {
  const source = (payload ?? {}) as { vibrateMs?: unknown; text?: unknown };
  const vibrateMs =
    typeof source.vibrateMs === "number" && Number.isFinite(source.vibrateMs)
      ? Math.min(Math.max(0, Math.round(source.vibrateMs)), DRIVER_VIBRATE_MAX_MS)
      : null;

  let text: string | null | undefined;
  if (source.text === null) {
    text = null;
  } else if (typeof source.text === "string") {
    const trimmed = source.text.trim().slice(0, DRIVER_TEXT_MAX_LENGTH);
    // An empty or whitespace-only string reads as "clear", not as a blank
    // line the player has to wait out.
    text = trimmed === "" ? null : trimmed;
  }
  return { vibrateMs, text };
};
