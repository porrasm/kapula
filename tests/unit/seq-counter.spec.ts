import { test, expect } from "@playwright/test";
import { createSeqCounter } from "@kapula/phone/utils";

/**
 * The phone owns the input seq (the server relays it as is and drops
 * non-increasing frames), so the counter has to be strictly increasing for
 * the whole player session and start above anything a previous page load
 * could have sent.
 */
test.describe("createSeqCounter", () => {
  test("starts above the seed and increases by one per frame", () => {
    const counter = createSeqCounter(1000);
    expect(counter.next()).toBe(1001);
    expect(counter.next()).toBe(1002);
    expect(counter.next()).toBe(1003);
  });

  test("defaults to a wall-clock seed so a reload outruns the previous load", () => {
    const before = Date.now();
    const counter = createSeqCounter();
    const first = counter.next();
    expect(first).toBeGreaterThan(before);
    expect(first).toBeLessThanOrEqual(Date.now() + 1);
    expect(Number.isSafeInteger(first)).toBe(true);
  });

  test("is shared between senders: two consumers never repeat or go back", () => {
    // Controller and PhysicalGamepadPanel both pull from the session's
    // counter; interleaved frames from either must keep the order.
    const counter = createSeqCounter(0);
    const a = () => counter.next();
    const b = () => counter.next();
    const seen = [a(), b(), b(), a(), a()];
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test("tolerates odd seeds: negatives clamp to zero, fractions floor", () => {
    expect(createSeqCounter(-5).next()).toBe(1);
    expect(createSeqCounter(7.9).next()).toBe(8);
  });
});
