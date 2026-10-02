import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GAMEPAD_CODE_LENGTH } from "@kapula/protocol";
import { Button, Card } from "./ui.js";
import { usePlayerApi } from "./player-api.js";
import { saveStoredPlayer, type StoredPlayer } from "./player-storage.js";

type JoinScreenProps = {
  initialJoinCode: string;
  onJoined: (player: StoredPlayer) => void;
};

/**
 * Joining takes only the code — the server assigns a name and color, and the
 * lobby is where players customize them (next to the ready toggle). When the
 * game predefined its players (a roster — typically a game recreating a lost
 * session), the player picks which of them they are instead.
 */
export const JoinScreen = ({ initialJoinCode, onJoined }: JoinScreenProps) => {
  const [joinCode, setJoinCode] = useState(initialJoinCode.toUpperCase());
  const [pickedName, setPickedName] = useState<string | null>(null);
  const api = usePlayerApi();

  const codeComplete = joinCode.length === GAMEPAD_CODE_LENGTH;
  const joinInfoQuery = useQuery({
    queryKey: ["gamepad", "join-info", joinCode],
    queryFn: () => api.fetchJoinInfo(joinCode),
    enabled: codeComplete,
    // The lobby fills up while the form is open; keep the count fresh.
    refetchInterval: 5000,
    retry: false,
  });
  const joinInfo = codeComplete ? (joinInfoQuery.data ?? null) : null;

  const joinMutation = useMutation({
    mutationFn: api.joinSession,
    onSuccess: (result) => {
      const player: StoredPlayer = {
        sessionId: result.sessionId,
        playerId: result.playerId,
        token: result.playerToken,
      };
      saveStoredPlayer(player);
      onJoined(player);
    },
  });

  const sessionFull =
    joinInfo !== null && joinInfo.playerCount >= joinInfo.maxPlayers;
  const roster = joinInfo?.roster ?? null;
  // The server decides whether a join is allowed (a running game accepts one
  // only when the driver set allowLateJoin); the screen just follows.
  const canJoin =
    joinInfo?.acceptingPlayers === true && !sessionFull && !joinMutation.isPending;

  const join = (name?: string) => {
    setPickedName(name ?? null);
    joinMutation.mutate(name ? { joinCode, name } : { joinCode });
  };

  return (
    <Card>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-kp-text-primary">
          Join a game
        </h2>

        <label className="block space-y-1">
          <span className="text-sm text-kp-text-secondary">Join code</span>
          <input
            className="w-full rounded-kp bg-kp-bg-tertiary border border-kp-border px-3 py-2 text-kp-text-primary text-xl tracking-[0.3em] font-mono uppercase"
            value={joinCode}
            maxLength={GAMEPAD_CODE_LENGTH}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            data-testid="join-code-input"
            onChange={(e) =>
              setJoinCode(
                e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
              )
            }
          />
        </label>

        {codeComplete && joinInfoQuery.isLoading && (
          <p className="text-sm text-kp-text-secondary">Looking up session…</p>
        )}
        {codeComplete && !joinInfoQuery.isLoading && !joinInfo && (
          <p className="text-sm text-kp-accent-danger">
            No session found with this code.
          </p>
        )}

        {joinInfo && (
          <>
            <div className="text-sm text-kp-text-secondary">
              {joinInfo.game ?? "Game session"} · {joinInfo.playerCount}/
              {joinInfo.maxPlayers} players
            </div>

            {!joinInfo.acceptingPlayers ? (
              <p className="text-sm text-kp-accent-warning">
                This session is not accepting new players right now.
              </p>
            ) : sessionFull ? (
              <p className="text-sm text-kp-accent-warning">
                The session is full.
              </p>
            ) : (
              <>
                {joinMutation.error && (
                  <p
                    className="text-sm text-kp-accent-danger"
                    data-testid="join-error"
                  >
                    {joinMutation.error.message}
                  </p>
                )}

                {roster ? (
                  <div className="space-y-2" data-testid="roster-picker">
                    <p className="text-sm text-kp-text-secondary">
                      The game knows its players — which one are you?
                    </p>
                    {roster.map((entry) => (
                      <Button
                        key={entry.name}
                        fullWidth
                        variant={entry.taken ? "secondary" : "primary"}
                        disabled={!canJoin || entry.taken}
                        loading={
                          joinMutation.isPending && pickedName === entry.name
                        }
                        data-testid="roster-slot"
                        data-name={entry.name}
                        data-taken={String(entry.taken)}
                        onClick={() => join(entry.name)}
                      >
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: entry.color }}
                          />
                          {entry.name}
                          {entry.taken ? " · already joined" : ""}
                        </span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Button
                    fullWidth
                    disabled={!canJoin}
                    loading={joinMutation.isPending}
                    data-testid="join-button"
                    onClick={() => join()}
                  >
                    Join
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
};
