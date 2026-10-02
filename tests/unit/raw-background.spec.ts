import { test, expect } from "@playwright/test";
import {
  KAPULA_PROTOCOL_VERSION,
  KAPULA_RAW_MAX_TOUCHES,
  controlSchemaSchema,
  kapulaInputFrameSchema,
  kapulaServerMessageSchema,
  kapulaSessionConfigSchema,
  kapulaSessionSnapshotSchema,
  getRawControl,
} from "@kapula/protocol";
import type { KapulaSessionSnapshot } from "@kapula/protocol";
import { sniffImageType } from "@kapula/server";
import {
  canCustomizeLayout,
  resolveLayout,
} from "@kapula/phone/utils";
import {
  allocateTouchSlot,
  touchPosition,
  touchesValue,
} from "@kapula/phone/utils";
import { applyServerMessage } from "@kapula/phone/utils";

const rawSchema = (controls: unknown[]) =>
  controlSchemaSchema.safeParse({ id: "pad", name: "Pad", controls });

test.describe("raw control schema", () => {
  test("a raw control alone, or with a gyro, is valid", () => {
    expect(rawSchema([{ type: "raw", id: "touch" }]).success).toBe(true);
    expect(
      rawSchema([
        { type: "raw", id: "touch" },
        { type: "gyro", id: "tilt" },
      ]).success,
    ).toBe(true);
  });

  test("any other control may sit on top of a raw control", () => {
    for (const other of [
      { type: "button", id: "a", label: "A" },
      { type: "joystick", id: "stick" },
      { type: "touchpad", id: "pad" },
      { type: "motion", id: "imu" },
    ]) {
      expect(rawSchema([{ type: "raw", id: "touch" }, other]).success).toBe(true);
      expect(rawSchema([other, { type: "raw", id: "touch" }]).success).toBe(true);
    }
  });

  test("at most one raw control per schema", () => {
    expect(
      rawSchema([
        { type: "raw", id: "one" },
        { type: "raw", id: "two" },
      ]).success,
    ).toBe(false);
  });

  test("schemas without a raw control are unaffected", () => {
    const parsed = controlSchemaSchema.parse({
      id: "tank",
      name: "Tank",
      controls: [
        { type: "joystick", id: "drive" },
        { type: "button", id: "fire", label: "Fire" },
        { type: "motion", id: "imu" },
      ],
    });
    expect(getRawControl(parsed)).toBeUndefined();
  });

  test("the layout engine places nothing and the editor is not offered", () => {
    const schema = controlSchemaSchema.parse({
      id: "pad",
      name: "Pad",
      controls: [
        { type: "raw", id: "touch" },
        { type: "gyro", id: "tilt" },
      ],
    });
    expect(resolveLayout(schema, { width: 800, height: 400 }).controls).toEqual([]);
    const config = kapulaSessionConfigSchema.parse({ schemas: [schema] });
    expect(canCustomizeLayout(config, schema)).toBe(false);
    // With something laid out on top, that something is editable.
    const withButton = controlSchemaSchema.parse({
      ...schema,
      controls: [...schema.controls, { type: "button", id: "a", label: "A" }],
    });
    expect(canCustomizeLayout(config, withButton)).toBe(true);
    expect(
      resolveLayout(withButton, { width: 800, height: 400 }).controls.map(
        (c) => c.control.id,
      ),
    ).toEqual(["a"]);
    const plain = kapulaSessionConfigSchema.parse({});
    expect(canCustomizeLayout(plain, plain.schemas[0])).toBe(true);
    expect(
      canCustomizeLayout(
        { ...plain, disallowLayoutCustomization: true },
        plain.schemas[0],
      ),
    ).toBe(false);
  });
});

test.describe("touchpad and button shape schema", () => {
  const schema = (controls: unknown[]) =>
    controlSchemaSchema.safeParse({ id: "pad", name: "Pad", controls });

  test("a touchpad takes an aspect within bounds", () => {
    expect(schema([{ type: "touchpad", id: "pad" }]).success).toBe(true);
    expect(
      schema([{ type: "touchpad", id: "pad", aspect: 1.5, label: "Mouse" }]).success,
    ).toBe(true);
    expect(schema([{ type: "touchpad", id: "pad", aspect: 0.1 }]).success).toBe(false);
    expect(schema([{ type: "touchpad", id: "pad", aspect: 5 }]).success).toBe(false);
    // Several pads are fine: each reports its own fingers under its own id.
    expect(
      schema([
        { type: "touchpad", id: "one" },
        { type: "touchpad", id: "two" },
      ]).success,
    ).toBe(true);
  });

  test("buttons are round or rect", () => {
    expect(schema([{ type: "button", id: "a", label: "A", shape: "rect" }]).success).toBe(
      true,
    );
    expect(schema([{ type: "button", id: "a", label: "A", shape: "round" }]).success).toBe(
      true,
    );
    expect(schema([{ type: "button", id: "a", label: "A", shape: "hex" }]).success).toBe(
      false,
    );
  });
});

test.describe("raw touch input", () => {
  const frame = (touch: unknown) =>
    kapulaInputFrameSchema.safeParse({ seq: 1, controls: { touch } });

  test("a list of fingers, empty included, is a valid value", () => {
    expect(frame([]).success).toBe(true);
    expect(
      frame([
        { id: 0, x: 0.125, y: 0.5 },
        { id: 3, x: 1, y: 0 },
      ]).success,
    ).toBe(true);
  });

  test("positions are 0–1 and ids are finger slots", () => {
    expect(frame([{ id: 0, x: 1.2, y: 0.5 }]).success).toBe(false);
    expect(frame([{ id: 0, x: 0.5, y: -0.1 }]).success).toBe(false);
    expect(frame([{ id: -1, x: 0.5, y: 0.5 }]).success).toBe(false);
    expect(frame([{ id: KAPULA_RAW_MAX_TOUCHES, x: 0.5, y: 0.5 }]).success).toBe(false);
    expect(frame([{ id: 0.5, x: 0.5, y: 0.5 }]).success).toBe(false);
    const tooMany = Array.from({ length: KAPULA_RAW_MAX_TOUCHES + 1 }, (_, id) => ({
      id: id % KAPULA_RAW_MAX_TOUCHES,
      x: 0,
      y: 0,
    }));
    expect(frame(tooMany).success).toBe(false);
  });

  test("slots are the lowest free id, reused after a lift", () => {
    expect(allocateTouchSlot([])).toBe(0);
    expect(allocateTouchSlot([0, 1])).toBe(2);
    expect(allocateTouchSlot([0, 2])).toBe(1);
    expect(
      allocateTouchSlot(Array.from({ length: KAPULA_RAW_MAX_TOUCHES }, (_, i) => i)),
    ).toBeNull();
  });

  test("positions are box fractions, clamped and rounded to 3 decimals", () => {
    // Offsets are from the box center, as pointerDeltaInFrame gives them.
    expect(touchPosition(0, 0, 800, 400)).toEqual({ x: 0.5, y: 0.5 });
    expect(touchPosition(-400, -200, 800, 400)).toEqual({ x: 0, y: 0 });
    expect(touchPosition(100.123456, 33.3333, 800, 400)).toEqual({ x: 0.625, y: 0.583 });
    // Dragged past the edge: pinned to it.
    expect(touchPosition(900, -900, 800, 400)).toEqual({ x: 1, y: 0 });
    expect(touchPosition(Number.NaN, 0, 800, 400)).toEqual({ x: 0, y: 0.5 });
  });

  test("the wire value lists fingers in slot order", () => {
    expect(
      touchesValue([
        { id: 2, x: 0.1, y: 0.2 },
        { id: 0, x: 0.3, y: 0.4 },
      ]),
    ).toEqual([
      { id: 0, x: 0.3, y: 0.4 },
      { id: 2, x: 0.1, y: 0.2 },
    ]);
  });
});

test.describe("background image", () => {
  const snapshot: KapulaSessionSnapshot = {
    protocolVersion: KAPULA_PROTOCOL_VERSION,
    sessionId: "s1",
    state: "in_progress",
    config: kapulaSessionConfigSchema.parse({}),
    driverConnected: true,
    players: [],
  };
  const background = { url: "/api/gamepad/background/abc", fit: "cover" as const };

  test("snapshots parse with and without one", () => {
    expect(kapulaSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      kapulaSessionSnapshotSchema.safeParse({ ...snapshot, background }).success,
    ).toBe(true);
    expect(
      kapulaSessionSnapshotSchema.safeParse({
        ...snapshot,
        background: { ...background, fit: "tile" },
      }).success,
    ).toBe(false);
  });

  test("background_changed sets and clears it on the phone's snapshot", () => {
    const set = kapulaServerMessageSchema.parse({
      type: "background_changed",
      background,
    });
    const withBackground = applyServerMessage(snapshot, set);
    expect(withBackground?.background).toEqual(background);

    const cleared = applyServerMessage(
      withBackground,
      kapulaServerMessageSchema.parse({ type: "background_changed", background: null }),
    );
    expect(cleared).not.toHaveProperty("background");
  });

  test("uploads are typed by their bytes, never by the claim", () => {
    const bytes = (...b: number[]) => Uint8Array.from([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "image/png",
    );
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe(
      "image/webp",
    );
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns=…>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});
