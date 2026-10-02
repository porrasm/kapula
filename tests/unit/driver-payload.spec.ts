import { test, expect } from "@playwright/test";
import {
  DRIVER_TEXT_MAX_LENGTH,
  DRIVER_VIBRATE_MAX_MS,
  parseDriverPayload,
} from "@kapula/phone/utils";

/**
 * The `message` relay is opaque to the server, so these conventions live
 * entirely on the phone: a driver opts in by sending the right shape, and
 * anything it does not recognize must pass through without breaking.
 */
test.describe("parseDriverPayload", () => {
  test("reads the two conventions", () => {
    expect(parseDriverPayload({ vibrateMs: 300 })).toEqual({
      vibrateMs: 300,
      text: undefined,
    });
    expect(parseDriverPayload({ text: "You are Red" })).toEqual({
      vibrateMs: null,
      text: "You are Red",
    });
    expect(parseDriverPayload({ vibrateMs: 100, text: "Go!" })).toEqual({
      vibrateMs: 100,
      text: "Go!",
    });
  });

  test("distinguishes clear from absent", () => {
    // null clears the line now; an absent key leaves whatever is up alone.
    expect(parseDriverPayload({ text: null }).text).toBeNull();
    expect(parseDriverPayload({ text: "   " }).text).toBeNull();
    expect(parseDriverPayload({ vibrateMs: 50 }).text).toBeUndefined();
    expect(parseDriverPayload({}).text).toBeUndefined();
  });

  test("clamps a buzz and truncates a long line", () => {
    expect(parseDriverPayload({ vibrateMs: 99_999 }).vibrateMs).toBe(
      DRIVER_VIBRATE_MAX_MS,
    );
    expect(parseDriverPayload({ vibrateMs: -5 }).vibrateMs).toBe(0);
    expect(parseDriverPayload({ vibrateMs: 12.6 }).vibrateMs).toBe(13);

    const long = "x".repeat(200);
    const text = parseDriverPayload({ text: long }).text;
    expect(text).toHaveLength(DRIVER_TEXT_MAX_LENGTH);
    // Truncated, not dropped: the player still sees something.
    expect(long.startsWith(text!)).toBe(true);
  });

  test("ignores everything it does not understand", () => {
    for (const payload of [
      null,
      undefined,
      42,
      "hello",
      [1, 2, 3],
      { hp: 40, score: [1, 2] },
      { vibrateMs: "300", text: 7 },
      { vibrateMs: Number.NaN },
    ]) {
      expect(parseDriverPayload(payload)).toEqual({
        vibrateMs: null,
        text: undefined,
      });
    }
  });
});
