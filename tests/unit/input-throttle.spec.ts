import { test, expect } from "@playwright/test";
import { inputThrottleMs } from "@kapula/phone/utils";

const schema = (controls: object[], rate?: string) =>
  ({ id: "s", name: "S", orientation: "auto", rate, controls }) as never;

test("inputThrottleMs: standard by default", () => {
  expect(inputThrottleMs(schema([{ type: "button", id: "a" }]))).toBe(33);
});
test("inputThrottleMs: rate fast", () => {
  expect(inputThrottleMs(schema([{ type: "fader", id: "f" }], "fast"))).toBe(16);
  expect(inputThrottleMs(schema([{ type: "fader", id: "f" }], "standard"))).toBe(33);
});
test("inputThrottleMs: pointer surfaces", () => {
  expect(inputThrottleMs(schema([{ type: "touchpad", id: "t" }]))).toBe(16);
  expect(inputThrottleMs(schema([{ type: "raw", id: "r" }]))).toBe(16);
});
