import { test, expect } from "@playwright/test";
import {
  fineScale,
  isDoubleTap,
  registerTap,
  scaleDragDelta,
  faderValueFromDelta,
} from "@kapula/phone/utils";

const at = (time: number, x = 100, y = 100) => ({ time, x, y });

test("double-tap accepts 250 ms and 8 px", () => {
  expect(isDoubleTap(at(1000), at(1250, 108, 100))).toBe(true);
  expect(isDoubleTap(at(1000), at(1250, 106, 106))).toBe(true);
});

test("double-tap rejects 400 ms or 20 px", () => {
  expect(isDoubleTap(at(1000), at(1400))).toBe(false);
  expect(isDoubleTap(at(1000), at(1100, 120, 100))).toBe(false);
  expect(isDoubleTap(null, at(1000))).toBe(false);
  expect(isDoubleTap(at(1000), at(900))).toBe(false);
});

test("registerTap: a double-tap consumes both taps", () => {
  const first = registerTap(null, at(0));
  expect(first).toEqual({ double: false, last: at(0) });
  const second = registerTap(first.last, at(200));
  expect(second).toEqual({ double: true, last: null });
  expect(registerTap(second.last, at(300)).double).toBe(false);
  // A slow second tap becomes the new first tap.
  expect(registerTap(at(0), at(500))).toEqual({ double: false, last: at(500) });
});

test("fine scaling applies 0.1 only while the modifier finger is down", () => {
  expect(fineScale(true)).toBe(0.1);
  expect(fineScale(false)).toBe(1);
  expect(scaleDragDelta(50, true)).toBeCloseTo(5);
  expect(scaleDragDelta(50, false)).toBe(50);
  expect(faderValueFromDelta(0.5, scaleDragDelta(50, true), 100)).toBeCloseTo(0.55);
  expect(faderValueFromDelta(0.5, scaleDragDelta(50, false), 100)).toBeCloseTo(1);
});
