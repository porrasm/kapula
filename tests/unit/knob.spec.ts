import { test, expect } from "@playwright/test";
import {
  KNOB_TRAVEL_PX,
  clampKnob,
  knobAngle,
  knobDragDelta,
  knobTurnsFromDelta,
  knobValueFromDelta,
  roundAxis,
} from "@kapula/phone/utils";

test.describe("knob absolute math", () => {
  test("travel is 150 px", () => {
    expect(KNOB_TRAVEL_PX).toBe(150);
    expect(knobValueFromDelta(0, 150)).toBe(1);
    expect(knobValueFromDelta(0.2, 75)).toBeCloseTo(0.7);
  });

  test("up is positive", () => {
    expect(knobDragDelta(100, 40)).toBe(60);
    expect(knobDragDelta(40, 100)).toBe(-60);
  });

  test("no movement does not jump", () => {
    expect(knobValueFromDelta(0.3, 0)).toBe(0.3);
  });

  test("clamps to [0, 1]", () => {
    expect(knobValueFromDelta(0.9, 500)).toBe(1);
    expect(knobValueFromDelta(0.1, -500)).toBe(0);
    expect(clampKnob(NaN)).toBe(0);
  });

  test("angle spans -135..135 degrees", () => {
    expect(knobAngle(0)).toBe(-135);
    expect(knobAngle(0.5)).toBe(0);
    expect(knobAngle(1)).toBe(135);
  });

  test("rounds to three decimals on the wire", () => {
    expect(roundAxis(knobValueFromDelta(0, 1))).toBe(0.007);
  });
});

test.describe("knob endless math", () => {
  test("one turn per 150 px, unclamped", () => {
    expect(knobTurnsFromDelta(0, 150)).toBe(1);
    expect(knobTurnsFromDelta(0, 1500)).toBe(10);
  });

  test("accumulates across several drags", () => {
    let turns = 0;
    turns = knobTurnsFromDelta(turns, 75);
    turns = knobTurnsFromDelta(turns, 150);
    turns = knobTurnsFromDelta(turns, 30);
    expect(turns).toBeCloseTo(1.7);
  });

  test("goes negative", () => {
    let turns = knobTurnsFromDelta(0, -300);
    expect(turns).toBe(-2);
    turns = knobTurnsFromDelta(turns, 75);
    expect(turns).toBeCloseTo(-1.5);
  });

  test("rounds to three decimals on the wire", () => {
    expect(roundAxis(knobTurnsFromDelta(-1, -1))).toBe(-1.007);
  });
});
