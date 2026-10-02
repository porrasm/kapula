import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "./ui.js";
import { usePlayerApi } from "./player-api.js";
import { JoinScreen } from "./JoinScreen.js";
import type { StoredPlayer } from "./player-storage.js";

export type PlayerHomeProps = {
  /** Prefilled join code, e.g. from a `/join/:code` link rendered as a QR code. */
  initialJoinCode: string;
  /** The device's stored credential, if any (see `loadStoredPlayer`). */
  player: StoredPlayer | null;
  /** Shown above the form, e.g. why the last session ended. */
  leaveMessage?: string | null;
  onJoined: (player: StoredPlayer) => void;
  /** The stored credential turned out dead: clear it, show the join form. */
  onStalePlayer: () => void;
  /** The player tapped "Open controller": navigate to the session screen. */
  onOpenController: () => void;
  /** Rendered above the join form when no session is stored (a host's extras). */
  children?: ReactNode;
};

/**
 * The landing content of a player page: either "you are in a game on this
 * device" with a button to open the controller, or the join form. The host
 * page owns the routing, the title and anything that needs an account.
 *
 * localStorage only says a session *was* joined; the server says whether it
 * still exists. The card waits for that answer so a player never sees "you
 * are in a game" about a session that ended while the phone was away.
 */
export const PlayerHome = ({
  initialJoinCode,
  player,
  leaveMessage = null,
  onJoined,
  onStalePlayer,
  onOpenController,
  children,
}: PlayerHomeProps) => {
  const api = usePlayerApi();
  const statusQuery = useQuery({
    queryKey: ["gamepad", "player-status", player?.token ?? ""],
    queryFn: () => api.fetchPlayerStatus(player?.token ?? ""),
    enabled: player !== null,
    retry: false,
    staleTime: 0,
  });
  const stale = player !== null && statusQuery.isSuccess && statusQuery.data === null;
  useEffect(() => {
    if (stale) onStalePlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale]);
  const status = statusQuery.data ?? null;

  return (
    <div className="space-y-4">
      {leaveMessage && (
        <p className="text-sm text-kp-text-secondary">{leaveMessage}</p>
      )}
      {player && !stale ? (
        statusQuery.isPending ? (
          <p className="text-sm text-kp-text-secondary" data-testid="checking-session">
            Checking your session…
          </p>
        ) : (
          <div className="rounded-kp bg-kp-bg-secondary p-3 space-y-2">
            <p className="text-sm text-kp-text-secondary">
              {status
                ? `You are ${status.name} in ${status.game ?? "a game"} on this device.`
                : "You are in a game on this device."}
            </p>
            <Button fullWidth data-testid="open-controller" onClick={onOpenController}>
              Open controller
            </Button>
          </div>
        )
      ) : (
        <>
          {children}
          <JoinScreen initialJoinCode={initialJoinCode} onJoined={onJoined} />
        </>
      )}
    </div>
  );
};
