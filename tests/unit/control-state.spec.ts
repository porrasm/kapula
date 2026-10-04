import { test, expect } from "@playwright/test";
import { toggleNext, stickReleaseValue } from "@kapula/phone/utils";
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
