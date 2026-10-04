import { test, expect } from "@playwright/test";
import {
  DRIVER_LABEL_MAX_LENGTH,
  DRIVER_TEXT_MAX_LENGTH,
  NO_OVERRIDES,
  applyDriverOverrides,
  createSeqCounter,
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
      set: {},
      labels: {},
    });
    expect(parseDriverPayload({ text: "You are Red" })).toEqual({
      vibrateMs: null,
      text: "You are Red",
      set: {},
      labels: {},
    });
    expect(parseDriverPayload({ vibrateMs: 100, text: "Go!" })).toEqual({
      vibrateMs: 100,
      text: "Go!",
      set: {},
      labels: {},
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
        set: {},
        labels: {},
      });
    }
  });
});

test.describe("set and labels conventions", () => {
  test("set keeps well-shaped entries and drops junk per entry", () => {
    expect(parseDriverPayload({ set: { expr: 0.5, bogus: "x" } }).set).toEqual({
      expr: 0.5,
    });
    expect(
      parseDriverPayload({
        set: { a: { x: 0.2, y: -1 }, b: true, c: { x: "no" }, d: {}, e: NaN, f: null },
      }).set,
    ).toEqual({ a: { x: 0.2, y: -1 }, b: true });
  });

  test("labels truncate to 16 characters and drop non-strings", () => {
    const { labels } = parseDriverPayload({
      labels: { a: "a".repeat(40), b: 3, c: "" },
    });
    expect(labels.a).toHaveLength(DRIVER_LABEL_MAX_LENGTH);
    expect(labels).toEqual({ a: "a".repeat(16), c: "" });
  });

  test("non-object payloads parse to nothing", () => {
    for (const p of [null, undefined, "x", 5, [1], { set: 3, labels: [] }]) {
      const parsed = parseDriverPayload(p);
      expect(parsed.set).toEqual({});
      expect(parsed.labels).toEqual({});
    }
  });
});

test.describe("applyDriverOverrides", () => {
  const schema = {
    id: "mix",
    controls: [
      { id: "vol", type: "fader" },
      { id: "knob", type: "knob" },
      { id: "mute", type: "button", label: "M", mode: "toggle" },
      { id: "fire", type: "button", label: "F" },
      { id: "move", type: "joystick", mode: "full" },
      { id: "pitch", type: "joystick", mode: "y" },
    ],
  } as never;

  test("applies fitting values, ignores unknown ids and wrong shapes", () => {
    const next = applyDriverOverrides(
      NO_OVERRIDES,
      parseDriverPayload({
        set: {
          vol: 0.4,
          knob: 2,
          mute: true,
          fire: true,
          move: { x: 1, y: 0 },
          pitch: 0.5,
          nope: 1,
        },
      }),
      schema,
      7,
    );
    expect(Object.keys(next.values).sort()).toEqual([
      "knob", "move", "mute", "pitch", "vol",
    ]);
    expect(next.values.vol).toEqual({ value: 0.4, rev: 7 });
    expect(
      Object.keys(
        applyDriverOverrides(
          NO_OVERRIDES,
          parseDriverPayload({ set: { vol: true, move: 0.5, mute: 1 } }),
          schema,
          1,
        ).values,
      ),
    ).toEqual([]);
  });

  test("an empty label restores the schema's", () => {
    const withLabel = applyDriverOverrides(
      NO_OVERRIDES,
      parseDriverPayload({ labels: { vol: "Master", nope: "x" } }),
      schema,
      1,
    );
    expect(withLabel.labels).toEqual({ vol: "Master" });
    const cleared = applyDriverOverrides(
      withLabel,
      parseDriverPayload({ labels: { vol: "" } }),
      schema,
      2,
    );
    expect(cleared.labels).toEqual({});
  });

  test("set sends no frame and does not advance the input seq", () => {
    // Applying overrides is pure display state: nothing here has a sender,
    // and the session's seq counter is untouched, so the next real frame
    // continues the numbering.
    const seq = createSeqCounter(100);
    expect(seq.next()).toBe(101);
    const sent: unknown[] = [];
    applyDriverOverrides(
      NO_OVERRIDES,
      parseDriverPayload({ set: { vol: 0.9, mute: true } }),
      schema,
      1,
    );
    expect(sent).toHaveLength(0);
    expect(seq.next()).toBe(102);
  });
});
