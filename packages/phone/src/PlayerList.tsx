import type { KapulaPlayerInfo, KapulaSessionSnapshot } from "@kapula/protocol";
import { Badge, Button } from "./ui.js";

type PlayerListProps = {
  players: KapulaPlayerInfo[];
  selfId?: string;
  showReady?: boolean;
  /** Host view only: removes the player from the session for good. */
  onKick?: (playerId: string) => void;
};

export const PlayerList = ({
  players,
  selfId,
  showReady,
  onKick,
}: PlayerListProps) => (
  <ul className="space-y-1" data-testid="player-list">
    {players.map((player) => (
      <li
        key={player.playerId}
        className={`flex items-center gap-2 rounded-kp px-3 py-2 bg-kp-bg-secondary ${
          player.connected ? "" : "opacity-50"
        }`}
      >
        <span
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: player.color }}
        />
        <span className="text-kp-text-primary text-sm flex-1 truncate">
          {player.name}
          {player.playerId === selfId ? " (you)" : ""}
        </span>
        {!player.connected && <Badge variant="warning">offline</Badge>}
        {showReady && player.connected && (
          <Badge variant={player.ready ? "success" : "neutral"}>
            {player.ready ? "ready" : "not ready"}
          </Badge>
        )}
        {onKick && (
          <Button
            size="small"
            variant="ghost"
            data-testid="kick-player"
            onClick={() => onKick(player.playerId)}
          >
            Remove
          </Button>
        )}
      </li>
    ))}
  </ul>
);

/** Roster slots nobody has claimed yet — the game waits for all of them. */
export const MissingRoster = ({
  snapshot,
}: {
  snapshot: KapulaSessionSnapshot;
}) => {
  const roster = snapshot.config.roster;
  if (!roster) return null;
  const joined = new Set(snapshot.players.map((p) => p.name.toLowerCase()));
  const missing = roster.filter((entry) => !joined.has(entry.name.toLowerCase()));
  if (missing.length === 0) return null;
  return (
    <div className="text-sm text-kp-text-secondary" data-testid="missing-roster">
      Waiting for:{" "}
      {missing.map((entry, i) => (
        <span key={entry.name}>
          {i > 0 && ", "}
          <span
            className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1"
            style={{ backgroundColor: entry.color }}
          />
          {entry.name}
        </span>
      ))}
    </div>
  );
};
