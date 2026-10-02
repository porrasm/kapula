import { test, expect } from "@playwright/test";
import { applyServerMessage } from "@kapula/phone/utils";
import {
  GAMEPAD_PROTOCOL_VERSION,
  gamepadSessionConfigSchema,
} from "@kapula/protocol";
import type {
  GamepadPlayerInfo,
  GamepadSessionSnapshot,
} from "@kapula/protocol";

const player = (id: string, extra: Partial<GamepadPlayerInfo> = {}): GamepadPlayerInfo => ({
  playerId: id,
  name: `Name ${id}`,
  color: "#FF6B6B",
  ready: false,
  connected: true,
  schemaId: "generic",
  ...extra,
});

const snapshot: GamepadSessionSnapshot = {
  protocolVersion: GAMEPAD_PROTOCOL_VERSION,
  sessionId: "s1",
  state: "waiting_for_players",
  config: gamepadSessionConfigSchema.parse({}),
  driverConnected: true,
  players: [player("p1"), player("p2")],
};

test.describe("applyServerMessage", () => {
  test("a snapshot replaces whatever came before", () => {
    expect(applyServerMessage(null, { type: "snapshot", snapshot })).toBe(
      snapshot,
    );
    const other = { ...snapshot, state: "paused" as const };
    expect(
      applyServerMessage(snapshot, { type: "snapshot", snapshot: other }),
    ).toBe(other);
  });

  test("events before the first snapshot are ignored", () => {
    expect(
      applyServerMessage(null, { type: "state_changed", state: "paused", reason: "driver_command" }),
    ).toBeNull();
    expect(
      applyServerMessage(null, { type: "player_joined", player: player("p9") }),
    ).toBeNull();
  });

  test("state changes patch only the state", () => {
    const next = applyServerMessage(snapshot, {
      type: "state_changed",
      state: "in_progress",
      reason: "driver_command",
    })!;
    expect(next.state).toBe("in_progress");
    expect(next.players).toBe(snapshot.players);
  });

  test("player_joined appends, but deduplicates on reconnect races", () => {
    const joined = applyServerMessage(snapshot, {
      type: "player_joined",
      player: player("p3"),
    })!;
    expect(joined.players.map((p) => p.playerId)).toEqual(["p1", "p2", "p3"]);

    // The server sends a fresh snapshot on reconnect; a player_joined that
    // raced with it must not duplicate the roster entry.
    const duplicate = applyServerMessage(joined, {
      type: "player_joined",
      player: player("p3"),
    })!;
    expect(duplicate.players).toHaveLength(3);
  });

  test("player_updated replaces the matching player only", () => {
    const next = applyServerMessage(snapshot, {
      type: "player_updated",
      player: player("p2", { name: "Renamed", ready: true }),
    })!;
    expect(next.players[0]).toBe(snapshot.players[0]);
    expect(next.players[1].name).toBe("Renamed");
    expect(next.players[1].ready).toBe(true);
  });

  test("player_updated for an unknown player is a no-op on the roster", () => {
    const next = applyServerMessage(snapshot, {
      type: "player_updated",
      player: player("p9"),
    })!;
    expect(next.players.map((p) => p.playerId)).toEqual(["p1", "p2"]);
  });

  test("player_left removes the player from the roster", () => {
    const next = applyServerMessage(snapshot, {
      type: "player_left",
      playerId: "p1",
    })!;
    expect(next.players.map((p) => p.playerId)).toEqual(["p2"]);
    // Unknown ids are a no-op, not a crash.
    const unknown = applyServerMessage(snapshot, {
      type: "player_left",
      playerId: "p9",
    })!;
    expect(unknown.players.map((p) => p.playerId)).toEqual(["p1", "p2"]);
  });

  test("connect and disconnect events flip the connected flag", () => {
    const off = applyServerMessage(snapshot, {
      type: "player_disconnected",
      playerId: "p1",
    })!;
    expect(off.players[0].connected).toBe(false);
    expect(off.players[1].connected).toBe(true);
    const on = applyServerMessage(off, {
      type: "player_connected",
      playerId: "p1",
    })!;
    expect(on.players[0].connected).toBe(true);
  });

  test("driver presence events flip driverConnected", () => {
    const lost = applyServerMessage(snapshot, { type: "driver_disconnected" })!;
    expect(lost.driverConnected).toBe(false);
    const back = applyServerMessage(lost, { type: "driver_connected" })!;
    expect(back.driverConnected).toBe(true);
  });

  test("non-roster messages leave the snapshot untouched", () => {
    for (const msg of [
      { type: "pong" } as const,
      { type: "message", payload: { vibrateMs: 50 } } as const,
      { type: "error", code: "invalid_state", message: "nope" } as const,
      { type: "input", playerId: "p1", seq: 1, controls: {} } as const,
    ]) {
      expect(applyServerMessage(snapshot, msg)).toBe(snapshot);
    }
  });
});
