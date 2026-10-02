import type { GamepadServerMessage, GamepadSessionSnapshot } from "@kapula/protocol";

/**
 * Folds roster/state events into the last full snapshot. The server sends a
 * fresh snapshot on every (re)connect, so events only need to patch it.
 */
export const applyServerMessage = (
  snapshot: GamepadSessionSnapshot | null,
  msg: GamepadServerMessage,
): GamepadSessionSnapshot | null => {
  if (msg.type === "snapshot") return msg.snapshot;
  if (!snapshot) return null;

  switch (msg.type) {
    case "state_changed":
      return { ...snapshot, state: msg.state };
    case "player_joined":
      if (snapshot.players.some((p) => p.playerId === msg.player.playerId)) {
        return snapshot;
      }
      return { ...snapshot, players: [...snapshot.players, msg.player] };
    case "player_updated":
      return {
        ...snapshot,
        players: snapshot.players.map((p) =>
          p.playerId === msg.player.playerId ? msg.player : p,
        ),
      };
    case "player_left":
      return {
        ...snapshot,
        players: snapshot.players.filter((p) => p.playerId !== msg.playerId),
      };
    case "player_connected":
    case "player_disconnected":
      return {
        ...snapshot,
        players: snapshot.players.map((p) =>
          p.playerId === msg.playerId
            ? { ...p, connected: msg.type === "player_connected" }
            : p,
        ),
      };
    case "driver_connected":
      return { ...snapshot, driverConnected: true };
    case "driver_disconnected":
      return { ...snapshot, driverConnected: false };
    case "background_changed": {
      // Absent, like a snapshot without one, rather than an explicit null.
      const { background: _previous, ...rest } = snapshot;
      return msg.background ? { ...rest, background: msg.background } : rest;
    }
    default:
      return snapshot;
  }
};
