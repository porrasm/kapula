import { test, expect } from "@playwright/test";
import {
  appendDebugEvent,
  buildRecoveryConfig,
  DEBUG_PRESETS,
  describeServerMessage,
  inputRateHz,
  recordInputFrame,
  MAX_DEBUG_EVENTS,
  type DebugInputs,
} from "@kapula/phone/utils";
import {
  KAPULA_PROTOCOL_VERSION,
  kapulaSessionConfigSchema,
} from "@kapula/protocol";
import type { KapulaSessionSnapshot } from "@kapula/protocol";

const inputMsg = (playerId: string, seq: number) =>
  ({ type: "input", playerId, seq, controls: { fire: seq % 2 === 0 } }) as const;

const snapshot: KapulaSessionSnapshot = {
  protocolVersion: KAPULA_PROTOCOL_VERSION,
  sessionId: "s1",
  state: "in_progress",
  config: kapulaSessionConfigSchema.parse({}),
  driverConnected: true,
  players: [
    {
      playerId: "p1",
      name: "Alice",
      color: "#FF6B6B",
      ready: true,
      connected: true,
      schemaId: "generic",
    },
  ],
};

test.describe("recordInputFrame", () => {
  test("stores the latest frame per player", () => {
    let inputs: DebugInputs = {};
    inputs = recordInputFrame(inputs, inputMsg("p1", 1), 1000);
    inputs = recordInputFrame(inputs, inputMsg("p1", 2), 1030);
    inputs = recordInputFrame(inputs, inputMsg("p2", 5), 1040);

    expect(inputs.p1.seq).toBe(2);
    expect(inputs.p2.seq).toBe(5);
    expect(inputs.p1.recentAt).toEqual([1000, 1030]);
  });

  test("drops stale or duplicate seq (highest-seq-wins contract)", () => {
    let inputs: DebugInputs = {};
    inputs = recordInputFrame(inputs, inputMsg("p1", 5), 1000);
    const after = recordInputFrame(inputs, inputMsg("p1", 4), 1100);
    expect(after).toBe(inputs);
    expect(recordInputFrame(inputs, inputMsg("p1", 5), 1100)).toBe(inputs);
  });

  test("prunes arrival timestamps outside the rate window", () => {
    let inputs: DebugInputs = {};
    inputs = recordInputFrame(inputs, inputMsg("p1", 1), 0);
    inputs = recordInputFrame(inputs, inputMsg("p1", 2), 5000);
    expect(inputs.p1.recentAt).toEqual([5000]);
  });
});

test.describe("inputRateHz", () => {
  test("counts only frames within the last second", () => {
    let inputs: DebugInputs = {};
    inputs = recordInputFrame(inputs, inputMsg("p1", 1), 0);
    inputs = recordInputFrame(inputs, inputMsg("p1", 2), 600);
    inputs = recordInputFrame(inputs, inputMsg("p1", 3), 1200);
    expect(inputRateHz(inputs.p1, 1200)).toBe(2);
    expect(inputRateHz(undefined, 1200)).toBe(0);
  });
});

test.describe("describeServerMessage", () => {
  test("skips high-rate messages", () => {
    expect(describeServerMessage(inputMsg("p1", 1), snapshot)).toBeNull();
    expect(describeServerMessage({ type: "pong" }, snapshot)).toBeNull();
  });

  test("resolves player names from the snapshot", () => {
    expect(
      describeServerMessage(
        { type: "player_disconnected", playerId: "p1" },
        snapshot,
      ),
    ).toBe("Alice disconnected");
    expect(
      describeServerMessage({ type: "player_left", playerId: "p1" }, snapshot),
    ).toBe("Alice left");
    // Unknown players fall back to a truncated id.
    expect(
      describeServerMessage(
        { type: "player_connected", playerId: "unknown-player-id" },
        snapshot,
      ),
    ).toBe("unknown- connected");
  });

  test("describes state changes and errors", () => {
    expect(
      describeServerMessage(
        { type: "state_changed", state: "paused", reason: "driver_disconnected" },
        snapshot,
      ),
    ).toBe("state → paused (driver_disconnected)");
    expect(
      describeServerMessage(
        { type: "error", code: "invalid_state", message: "Cannot start" },
        snapshot,
      ),
    ).toBe("error invalid_state: Cannot start");
    expect(describeServerMessage({ type: "snapshot", snapshot }, null)).toBe(
      "snapshot: in_progress, 1 player(s)",
    );
  });
});

test.describe("appendDebugEvent", () => {
  test("caps the log length", () => {
    let events = Array.from({ length: MAX_DEBUG_EVENTS }, (_, i) => ({
      at: i,
      text: `event ${i}`,
    }));
    events = appendDebugEvent(events, { at: 999, text: "newest" });
    expect(events).toHaveLength(MAX_DEBUG_EVENTS);
    expect(events[events.length - 1].text).toBe("newest");
    expect(events[0].text).toBe("event 1");
  });
});

test.describe("DEBUG_PRESETS", () => {
  // Presets are pasted into the setup form and sent to the real driver-setup
  // endpoint, so every one must pass the wire schema (id format, control
  // count, label length) or the button produces an instant setup error.
  for (const preset of DEBUG_PRESETS) {
    test(`the ${preset.key} preset passes the session config schema`, () => {
      const parsed = kapulaSessionConfigSchema.safeParse(preset.config);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });
  }
});

/**
 * The debug driver's "set up again with the same players" is the reference
 * implementation of the lost-session recovery a real game does.
 */
test.describe("buildRecoveryConfig", () => {
  const config = kapulaSessionConfigSchema.parse({
    game: "Recover Me",
    minPlayers: 2,
    maxPlayers: 6,
  });
  const snapshot: KapulaSessionSnapshot = {
    protocolVersion: KAPULA_PROTOCOL_VERSION,
    sessionId: "s1",
    state: "paused",
    config,
    driverConnected: false,
    players: [
      {
        playerId: "p1",
        name: "Alice",
        color: "#FF6B6B",
        ready: true,
        connected: false,
        schemaId: "generic",
      },
      {
        playerId: "p2",
        name: "Bob",
        color: "#4D96FF",
        ready: false,
        connected: true,
        schemaId: "generic",
      },
    ],
  };

  test("carries the players over as a roster and drops the old counts", () => {
    const recovery = buildRecoveryConfig(snapshot);
    expect(recovery?.roster).toEqual([
      { name: "Alice", color: "#FF6B6B" },
      { name: "Bob", color: "#4D96FF" },
    ]);
    expect(recovery?.game).toBe("Recover Me");
    expect(recovery).not.toHaveProperty("minPlayers");
    expect(recovery).not.toHaveProperty("maxPlayers");
    // It must be a valid setup config, sized to the roster.
    const parsed = kapulaSessionConfigSchema.parse(recovery);
    expect(parsed.minPlayers).toBe(2);
    expect(parsed.maxPlayers).toBe(2);
  });

  test("an empty session has nothing to recover", () => {
    expect(buildRecoveryConfig({ ...snapshot, players: [] })).toBeNull();
  });
});
