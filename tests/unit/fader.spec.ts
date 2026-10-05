import { test, expect } from "@playwright/test";
import {
  clampFader,
  faderAxisDelta,
  faderReleaseValue,
  faderValueFromDelta,
  roundAxis,
} from "@kapula/phone/utils";

test.describe("fader value math", () => {
  test("clamps to [0, 1]", () => {
    expect(clampFader(-3)).toBe(0);
    expect(clampFader(2)).toBe(1);
    expect(clampFader(0.4)).toBe(0.4);
    expect(clampFader(NaN)).toBe(0);
  });

  test("value follows the drag delta from the landing value", () => {
    // No movement: no jump.
    expect(faderValueFromDelta(0.3, 0, 200)).toBe(0.3);
    expect(faderValueFromDelta(0.3, 50, 200)).toBeCloseTo(0.55);
    expect(faderValueFromDelta(0.3, -20, 200)).toBeCloseTo(0.2);
  });

  test("dragging past either end clamps", () => {
    expect(faderValueFromDelta(0.9, 500, 200)).toBe(1);
    expect(faderValueFromDelta(0.1, -500, 200)).toBe(0);
    expect(faderValueFromDelta(0.6, 10, 0)).toBe(0.6);
  });

  test("axis delta: up is positive for v, right for h", () => {
    const from = { dx: 0, dy: 40 };
    const to = { dx: 25, dy: 10 };
    expect(faderAxisDelta("v", from, to)).toBe(30);
    expect(faderAxisDelta("h", from, to)).toBe(25);
  });

  test("release: spring returns default, otherwise keeps the value", () => {
    expect(faderReleaseValue(true, 0.5, 0.9)).toBe(0.5);
    expect(faderReleaseValue(false, 0.5, 0.9)).toBe(0.9);
  });

  test("wire value is rounded to three decimals", () => {
    expect(roundAxis(faderValueFromDelta(0, 1, 3))).toBe(0.333);
  });
});
