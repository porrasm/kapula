import { test, expect } from "@playwright/test";
import { toggleNext, stickReleaseValue, stickAnchor } from "@kapula/phone/utils";
import { kapulaControlSchema } from "@kapula/protocol";

test.describe("control state helpers", () => {
  test("toggle flips true/false/true across three taps", () => {
    let on = false;
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      on = toggleNext(on);
      seen.push(on);
    }
    expect(seen).toEqual([true, false, true]);
  });

  test("release keeps the value when spring is false", () => {
    expect(stickReleaseValue(false, { x: 0.4, y: -0.7 })).toEqual({
      x: 0.4,
      y: -0.7,
    });
  });

  test("release centers when spring is true or unset", () => {
    expect(stickReleaseValue(true, { x: 0.4, y: -0.7 })).toEqual({ x: 0, y: 0 });
    expect(stickReleaseValue(undefined, { x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
  });

  test("spring stick anchors at center: edge touch is full deflection", () => {
    const landing = { x: 40, y: 0 };
    const a = stickAnchor(true, landing, { x: 0, y: 0 });
    expect(a).toEqual({ x: 0, y: 0 });
    expect(stickAnchor(undefined, landing, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    // value on touch-down = delta - anchor, non-zero
    expect(landing.x - a.x).toBe(40);
  });

  test("non-spring stick continues from the held offset without a jump", () => {
    const landing = { x: -30, y: 10 };
    const held = { x: 20, y: -5 };
    const a = stickAnchor(false, landing, held);
    expect({ x: landing.x - a.x, y: landing.y - a.y }).toEqual(held);
  });

  test("schema accepts spring and toggle mode", () => {
    const stick = kapulaControlSchema.parse({
      type: "joystick",
      id: "xy",
      spring: false,
    });
    expect(stick).toMatchObject({ mode: "full", spring: false });
    const btn = kapulaControlSchema.parse({
      type: "button",
      id: "mute",
      label: "M",
      mode: "toggle",
    });
    expect(btn).toMatchObject({ mode: "toggle" });
    expect(
      kapulaControlSchema.safeParse({ type: "button", id: "b", label: "B", mode: "x" })
        .success,
    ).toBe(false);
    expect(
      kapulaControlSchema.safeParse({ type: "joystick", id: "s", spring: "no" })
        .success,
    ).toBe(false);
  });
});
