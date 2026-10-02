import { test, expect } from "@playwright/test";
import {
  KAPULA_PROTOCOL_VERSION,
  GENERIC_GAMEPAD_SCHEMA,
  kapulaDriverClientMessageSchema,
  kapulaDriverSetupRequestSchema,
  kapulaLinkedEmailsSchema,
  KAPULA_DRIVER_KEY_MAX_LINKED_EMAILS,
  kapulaPlayerClientMessageSchema,
  kapulaServerMessageSchema,
  kapulaSessionConfigSchema,
  kapulaSessionSnapshotSchema,
} from "@kapula/protocol";

/**
 * Wire-contract tests for the WebSocket message schemas. The signaling server
 * silently drops any client frame these reject, and the protocol-level e2e
 * suite asserts every server frame parses with kapulaServerMessageSchema —
 * so this file pins down exactly what is in and out of the contract.
 */

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }) =>
  (value: unknown) => expect(schema.safeParse(value).success).toBe(true);
const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }) =>
  (value: unknown) => expect(schema.safeParse(value).success).toBe(false);

test.describe("player client messages", () => {
  const ok = accepts(kapulaPlayerClientMessageSchema);
  const bad = rejects(kapulaPlayerClientMessageSchema);

  test("accepts every documented message", () => {
    ok({ type: "ping" });
    ok({ type: "set_ready", ready: true });
    ok({ type: "select_schema", schemaId: "tank-v2" });
    ok({ type: "update_profile", name: "Alice" });
    ok({ type: "update_profile", color: "#AABB01" });
    ok({ type: "update_profile" }); // both optional; server fills from current
    ok({
      type: "input",
      seq: 0,
      controls: { fire: true, stick: { x: -1, y: 1 } },
    });
    // Single-axis and dpad joystick values.
    ok({
      type: "input",
      seq: 1,
      controls: { steer: { x: 0.5 }, throttle: { y: -1 }, look: "dl" },
    });
    ok({ type: "input", seq: 42, controls: {} });
    // A physical gamepad's triggers are bare scalars.
    ok({ type: "input", seq: 43, controls: { lt: 0.5, rt: 1, dpad: "ul" } });
    ok({ type: "leave" });
  });

  test("rejects missing fields and wrong payloads", () => {
    bad({});
    bad({ type: "unknown" });
    bad({ type: "set_ready" });
    bad({ type: "set_ready", ready: "yes" });
    bad({ type: "select_schema" });
    bad({ type: "select_schema", schemaId: "Not-Kebab" });
    bad({ type: "update_profile", name: "" });
    bad({ type: "update_profile", name: "way too long a name" });
    bad({ type: "update_profile", color: "red" });
    bad({ type: "update_profile", color: "#ABC" });
    bad({ type: "input", seq: 1, controls: { rt: 2 } });
    bad({ type: "input", seq: 1, controls: { rt: "0.5" } });
  });

  test("rejects malformed input frames", () => {
    bad({ type: "input", controls: {} }); // no seq
    bad({ type: "input", seq: -1, controls: {} });
    bad({ type: "input", seq: 1.5, controls: {} });
    bad({ type: "input", seq: 1, controls: { stick: { x: 1.01, y: 0 } } });
    bad({ type: "input", seq: 1, controls: { stick: {} } }); // no axis at all
    bad({ type: "input", seq: 1, controls: { stick: { x: 1.01 } } });
    bad({ type: "input", seq: 1, controls: { fire: "pressed" } }); // not a dpad direction
    bad({ type: "input", seq: 1, controls: { UPPER: true } }); // ids are kebab-case
    bad({ type: "input", seq: 1, controls: { ["x".repeat(33)]: true } });
  });

  test("driver-only messages are not valid player messages", () => {
    bad({ type: "start" });
    bad({ type: "end" });
    bad({ type: "message", payload: {} });
  });
});

test.describe("driver client messages", () => {
  const ok = accepts(kapulaDriverClientMessageSchema);
  const bad = rejects(kapulaDriverClientMessageSchema);

  test("accepts lifecycle commands and message relays", () => {
    ok({ type: "ping" });
    ok({ type: "start" });
    ok({ type: "pause" });
    ok({ type: "resume" });
    ok({ type: "end" });
    ok({ type: "message", payload: { vibrateMs: 100 } });
    ok({ type: "message", playerId: "7", payload: [1, 2, 3] });
    ok({ type: "message" }); // payload is unknown, may be absent
    ok({ type: "set_schema", schemaId: "tank" }); // every player
    ok({ type: "set_schema", playerId: "7", schemaId: "tank" }); // one player
  });

  test("rejects player-only and unknown messages", () => {
    bad({ type: "input", seq: 1, controls: {} });
    bad({ type: "set_ready", ready: true });
    bad({ type: "leave" });
    bad({ type: "restart" });
    bad({ type: "message", playerId: 7, payload: {} }); // playerId is a string
    bad({ type: "set_schema" }); // schemaId is required
    bad({ type: "set_schema", schemaId: 3 });
  });
});

test.describe("server messages", () => {
  const ok = accepts(kapulaServerMessageSchema);
  const bad = rejects(kapulaServerMessageSchema);

  const player = {
    playerId: "1",
    name: "Alice",
    color: "#FF6B6B",
    ready: false,
    connected: true,
    schemaId: "generic",
  };

  test("accepts every documented message", () => {
    ok({ type: "pong" });
    ok({
      type: "snapshot",
      snapshot: {
        protocolVersion: KAPULA_PROTOCOL_VERSION,
        sessionId: "1",
        state: "waiting_for_players",
        config: kapulaSessionConfigSchema.parse({}),
        driverConnected: true,
        players: [player],
      },
      playerId: "1",
    });
    ok({
      type: "state_changed",
      state: "paused",
      reason: "driver_disconnected",
    });
    ok({ type: "player_joined", player });
    ok({ type: "player_updated", player });
    ok({ type: "player_connected", playerId: "1" });
    ok({ type: "player_disconnected", playerId: "1" });
    ok({ type: "player_left", playerId: "1" });
    ok({ type: "driver_connected" });
    ok({ type: "driver_disconnected" });
    ok({ type: "input", playerId: "1", seq: 3, controls: { fire: false } });
    ok({ type: "message", payload: { anything: true } });
    ok({ type: "error", code: "invalid_state", message: "nope" });
  });

  test("rejects unknown types, states, reasons and error codes", () => {
    bad({ type: "unknown" });
    bad({ type: "state_changed", state: "exploded" });
    bad({ type: "state_changed", state: "paused", reason: "cosmic-rays" });
    bad({ type: "state_changed", state: "paused" }); // reason required
    bad({ type: "player_joined", player: { ...player, color: "red" } });
    bad({ type: "error", code: "invalid_state" }); // message required
    bad({ type: "error", code: "kaboom", message: "nope" }); // code is an enum
    bad({ type: "input", seq: 3, controls: {} }); // playerId required
  });
});

test.describe("driver setup request", () => {
  test("omitted config defaults to a single generic schema", () => {
    const parsed = kapulaDriverSetupRequestSchema.parse({
      setupCode: "abc234",
    });
    expect(parsed.setupCode).toBe("ABC234"); // normalized
    expect(parsed.config.schemas).toEqual([GENERIC_GAMEPAD_SCHEMA]);
    expect(parsed.config.minPlayers).toBe(1);
    expect(parsed.config.maxPlayers).toBe(8);
  });

  test("rejects invalid codes and configs", () => {
    const bad = rejects(kapulaDriverSetupRequestSchema);
    bad({});
    bad({ setupCode: "ABC10I" }); // ambiguous characters
    bad({ setupCode: "ABC234", config: { minPlayers: 3, maxPlayers: 2 } });
  });
});

test.describe("session config boundaries", () => {
  const bad = rejects(kapulaSessionConfigSchema);

  const controls = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "button",
      id: `b-${i}`,
      label: `B${i}`,
    }));
  const schemas = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s-${i}`,
      name: `S${i}`,
      controls: controls(1),
    }));

  test("player counts are capped at 12", () => {
    expect(kapulaSessionConfigSchema.parse({ maxPlayers: 12 }).maxPlayers).toBe(12);
    bad({ maxPlayers: 13 });
    bad({ minPlayers: 0 });
    bad({ minPlayers: 13, maxPlayers: 12 });
  });

  test("schema and control list sizes are bounded", () => {
    expect(
      kapulaSessionConfigSchema.parse({ schemas: schemas(32) }).schemas,
    ).toHaveLength(32);
    bad({ schemas: [] });
    bad({ schemas: schemas(33) });
    bad({ schemas: [{ id: "s", name: "S", controls: [] }] });
    bad({ schemas: [{ id: "s", name: "S", controls: controls(17) }] });
    expect(
      kapulaSessionConfigSchema.parse({
        schemas: [{ id: "s", name: "S", controls: controls(16) }],
      }).schemas[0].controls,
    ).toHaveLength(16);
  });

  test("labels, ids and colors are bounded", () => {
    bad({
      schemas: [
        {
          id: "s",
          name: "S",
          controls: [{ type: "button", id: "b", label: "x".repeat(17) }],
        },
      ],
    });
    bad({
      schemas: [
        {
          id: "s",
          name: "S",
          controls: [{ type: "button", id: "b", label: "" }],
        },
      ],
    });
    // Buttons require a label; joysticks do not.
    bad({
      schemas: [{ id: "s", name: "S", controls: [{ type: "button", id: "b" }] }],
    });
    expect(
      kapulaSessionConfigSchema.safeParse({
        schemas: [{ id: "s", name: "S", controls: [{ type: "joystick", id: "j" }] }],
      }).success,
    ).toBe(true);
    bad({ colors: Array.from({ length: 25 }, (_, i) => `#0000${String(i).padStart(2, "0")}`) });
  });
});

test.describe("session snapshot", () => {
  test("round-trips a realistic snapshot", () => {
    const snapshot = {
      protocolVersion: KAPULA_PROTOCOL_VERSION,
      sessionId: "17",
      state: "in_progress",
      config: kapulaSessionConfigSchema.parse({ game: "Tanks" }),
      driverConnected: false,
      players: [],
    };
    expect(kapulaSessionSnapshotSchema.parse(snapshot).state).toBe(
      "in_progress",
    );
    expect(
      kapulaSessionSnapshotSchema.safeParse({ ...snapshot, state: "nope" })
        .success,
    ).toBe(false);
  });
});

test.describe("private sessions and linked emails", () => {
  test("private defaults off", () => {
    expect(kapulaSessionConfigSchema.parse({}).private).toBe(false);
    expect(kapulaSessionConfigSchema.parse({ private: true }).private).toBe(true);
  });

  test("linked emails are trimmed, lowercased and deduplicated", () => {
    expect(
      kapulaLinkedEmailsSchema.parse([
        " Partner@Example.com ",
        "partner@example.com",
        "me@example.org",
      ]),
    ).toEqual(["partner@example.com", "me@example.org"]);
  });

  test("anything but emails, or too many, is refused", () => {
    expect(kapulaLinkedEmailsSchema.safeParse(["not an email"]).success).toBe(false);
    expect(kapulaLinkedEmailsSchema.safeParse([""]).success).toBe(false);
    const many = Array.from(
      { length: KAPULA_DRIVER_KEY_MAX_LINKED_EMAILS + 1 },
      (_, i) => `p${i}@example.com`,
    );
    expect(kapulaLinkedEmailsSchema.safeParse(many).success).toBe(false);
  });
});
