import { test, expect } from "@playwright/test";
import { schemaTabs } from "@kapula/phone/utils";
import { kapulaSessionConfigSchema } from "@kapula/protocol";

const config = (allowPhysicalGamepad: boolean) =>
  ({
    schemas: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    allowPhysicalGamepad,
  }) as never;

test("schemaTabs: follows config order and marks the current id", () => {
  const tabs = schemaTabs(config(false), "b");
  expect(tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
  expect(tabs.map((t) => t.current)).toEqual([false, true, false]);
  expect(tabs[0].name).toBe("A");
});

test("schemaTabs: physical gamepad only when allowed", () => {
  expect(schemaTabs(config(false), "a").some((t) => t.id === "physical-gamepad")).toBe(false);
  const tabs = schemaTabs(config(true), "physical-gamepad");
  expect(tabs.at(-1)).toMatchObject({ id: "physical-gamepad", current: true });
  expect(tabs.slice(0, 3).every((t) => !t.current)).toBe(true);
});

test("config chrome: slim accepted, absent stays absent, bad value rejected", () => {
  expect(kapulaSessionConfigSchema.parse({ chrome: "slim" }).chrome).toBe("slim");
  expect(kapulaSessionConfigSchema.parse({}).chrome).toBeUndefined();
  expect(kapulaSessionConfigSchema.safeParse({ chrome: "tiny" }).success).toBe(false);
});

test("schemaTabs: disabled follows gyro access and gamepad support", () => {
  const cfg = {
    schemas: [
      { id: "a", name: "A", controls: [{ type: "button", id: "x" }] },
      { id: "t", name: "Tilt", controls: [{ type: "gyro", id: "g" }] },
    ],
    allowPhysicalGamepad: true,
  } as never;
  expect(schemaTabs(cfg, "a").map((t) => t.disabled)).toEqual([false, false, false]);
  expect(
    schemaTabs(cfg, "a", { gyroBlocked: true, physicalSupported: false }).map((t) => t.disabled),
  ).toEqual([false, true, true]);
});
