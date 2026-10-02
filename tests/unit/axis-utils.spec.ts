import { test, expect } from "@playwright/test";
import {
  AXIS_DECIMALS,
  roundAxis,
} from "@kapula/phone/utils";
import { gyroAxisValue } from "@kapula/phone/utils";
import { gamepadInputFrameSchema } from "@kapula/protocol";

/**
 * Every analog value on the wire goes through roundAxis: a dragged stick or a
 * tilting phone otherwise sends 17-digit doubles 30 times a second.
 */
test.describe("roundAxis", () => {
  test("keeps three decimals", () => {
    expect(AXIS_DECIMALS).toBe(3);
    expect(roundAxis(0.5836734693877551)).toBe(0.584);
    expect(roundAxis(-0.1234567)).toBe(-0.123);
    expect(roundAxis(0.0005)).toBe(0.001);
    // Values that are already short are untouched, including the extremes.
    for (const v of [0, 1, -1, 0.5, -0.25, 0.125]) {
      expect(roundAxis(v)).toBe(v);
    }
  });

  test("never emits -0, and treats a broken reading as centered", () => {
    expect(Object.is(roundAxis(-0.0001), 0)).toBe(true);
    expect(Object.is(roundAxis(-0), 0)).toBe(true);
    expect(roundAxis(Number.NaN)).toBe(0);
    expect(roundAxis(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("shortens what a full-precision axis costs on the wire", () => {
    const raw = { x: 0.5836734693877551, y: -0.9183673469387755 };
    const rounded = { x: roundAxis(raw.x), y: roundAxis(raw.y) };
    expect(JSON.stringify(rounded).length).toBeLessThan(
      JSON.stringify(raw).length / 2,
    );
    // Still a legal axis pair, and still where the thumb put it.
    expect(
      gamepadInputFrameSchema.safeParse({ seq: 1, controls: { drive: rounded } })
        .success,
    ).toBe(true);
    expect(rounded.x).toBeCloseTo(raw.x, 3);
    expect(rounded.y).toBeCloseTo(raw.y, 3);
  });

  test("tilt output is rounded on its way out", () => {
    const axes = { x: 0.1234567, y: -0.7654321 };
    expect(gyroAxisValue("full", axes)).toEqual({ x: 0.123, y: -0.765 });
    expect(gyroAxisValue("x", axes)).toEqual({ x: 0.123 });
    expect(gyroAxisValue("y", axes)).toEqual({ y: -0.765 });
  });
});
