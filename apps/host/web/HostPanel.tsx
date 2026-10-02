import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KAPULA_METADATA_MAX_LENGTH,
  type KapulaServerMessage,
  type KapulaSessionSnapshot,
  type KapulaStateChangeReason,
} from "@kapula/protocol";
import type { KapulaMySession } from "@kapula/server";
import {
  Badge,
  Button,
  Card,
  DRIVER_LOST_MINUTES,
  MissingRoster,
  PlayerList,
  applyServerMessage,
  buildKapulaWsUrl,
  sessionEndedNote,
  useKapulaSocket,
  useKapulaConfig,
} from "@kapula/phone";
import { hostCall } from "./host-api";

/**
 * The logged-in side of the landing page: create the hosted session and
 * watch it live, plus the sessions opened by the user's driver keys. (Driver
 * keys themselves are managed through the host API for now — see the
 * backlog.) Mirrors the monorepo's HostPanel, over the JSON host API.
 */
export const HostPanel = () => (
  <>
    <SessionCard />
    <KeySessions />
  </>
);

const useSessions = () =>
  useQuery({
    queryKey: ["host", "sessions"],
    queryFn: () => hostCall<KapulaMySession[]>("listMySessions"),
    refetchInterval: 15_000,
  });

const useInvalidateSessions = () => {
  const queryClient = useQueryClient();
  return useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ["host"] }),
    [queryClient],
  );
};

const KeySessions = () => {
  const listQuery = useSessions();
  const keySessions = (listQuery.data ?? []).filter((s) => s.driverKeyId !== null);
  return (
    <>
      {keySessions.map((session) => (
        <HostDashboard
          key={session.sessionId}
          sessionId={session.sessionId}
          title={session.driverKeyName ?? "Driver key session"}
          onEnded={() => {}}
        />
      ))}
    </>
  );
};

const SessionCard = () => {
  const invalidateSessions = useInvalidateSessions();
  const sessionQuery = useQuery({
    queryKey: ["host", "my-session"],
    queryFn: () => hostCall<KapulaMySession | null>("getMySession"),
  });
  const createMutation = useMutation({
    mutationFn: (metadata: string | undefined) =>
      hostCall("createSession", metadata ? { metadata } : undefined),
    onSuccess: () => {
      setEndedNote(null);
      invalidateSessions();
    },
  });
  const [showMetadata, setShowMetadata] = useState(false);
  const [metadata, setMetadata] = useState("");
  const [endedNote, setEndedNote] = useState<string | null>(null);

  const session = sessionQuery.data ?? null;
  if (!session) {
    return (
      <Card>
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-kp-text-primary">Host a session</h2>
          {endedNote && (
            <p className="text-sm text-kp-accent-warning" data-testid="session-ended-note">
              {endedNote}
            </p>
          )}
          <p className="text-sm text-kp-text-secondary">
            Create a session to get a setup code for your game. The game claims the
            session with it, and players then join with a separate join code.
          </p>
          {showMetadata ? (
            <textarea
              className="w-full h-24 rounded-kp bg-kp-bg-tertiary border border-kp-border px-3 py-2 text-kp-text-primary font-mono text-xs"
              value={metadata}
              maxLength={KAPULA_METADATA_MAX_LENGTH}
              spellCheck={false}
              placeholder="Metadata handed to the game at setup (optional)"
              data-testid="session-metadata-input"
              onChange={(e) => setMetadata(e.target.value)}
            />
          ) : (
            <button
              className="text-sm text-kp-accent-primary underline"
              type="button"
              onClick={() => setShowMetadata(true)}
            >
              Add metadata for the game (optional)
            </button>
          )}
          {createMutation.error && (
            <p className="text-sm text-kp-accent-danger">{createMutation.error.message}</p>
          )}
          <Button
            loading={createMutation.isPending}
            data-testid="create-session-button"
            onClick={() => createMutation.mutate(metadata.trim() || undefined)}
          >
            Create session
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <HostDashboard
      sessionId={session.sessionId}
      title="Your session"
      onEnded={(reason) => setEndedNote(sessionEndedNote(reason))}
    />
  );
};

const STATE_LABELS: Record<KapulaSessionSnapshot["state"], string> = {
  not_initialized: "Waiting for the game",
  waiting_for_players: "Lobby open",
  in_progress: "In progress",
  paused: "Paused",
  ended: "Ended",
};

const HostDashboard = ({
  sessionId,
  title,
  onEnded,
}: {
  sessionId: string;
  title: string;
  onEnded: (reason: KapulaStateChangeReason | null) => void;
}) => {
  const invalidateSessions = useInvalidateSessions();
  const listQuery = useSessions();
  const session = listQuery.data?.find((s) => s.sessionId === sessionId) ?? null;

  const [snapshot, setSnapshot] = useState<KapulaSessionSnapshot | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [endReason, setEndReason] = useState<KapulaStateChangeReason | null>(null);

  const { apiBase } = useKapulaConfig();
  const url = useMemo(
    () => buildKapulaWsUrl(apiBase, { role: "host", sessionId }),
    [apiBase, sessionId],
  );
  const onMessage = useCallback(
    (msg: KapulaServerMessage) => {
      setSnapshot((prev) => applyServerMessage(prev, msg));
      if (msg.type === "state_changed" && msg.state === "ended") setEndReason(msg.reason);
      // Codes and config live in the session query; refresh it whenever the
      // session moves (e.g. the driver's setup call created the join code).
      if (msg.type === "snapshot" || msg.type === "state_changed") invalidateSessions();
    },
    [invalidateSessions],
  );
  const { fatalClose } = useKapulaSocket(url, onMessage);

  const endMutation = useMutation({
    mutationFn: () => hostCall("endMySession", { sessionId }),
    onSuccess: invalidateSessions,
  });
  const kickMutation = useMutation({
    mutationFn: (playerId: string) => hostCall("kickPlayer", { playerId, sessionId }),
  });

  const endedElsewhere =
    fatalClose?.code === 4005 || fatalClose?.code === 4004 || snapshot?.state === "ended";
  useEffect(() => {
    if (!endedElsewhere) return;
    onEnded(endReason);
    invalidateSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endedElsewhere]);
  if (endedElsewhere) return null;

  const state = snapshot?.state ?? session?.state ?? "not_initialized";
  const isPrivate = session?.private === true;
  const joinCode = isPrivate ? null : (session?.joinCode ?? null);
  const joinLink = joinCode ? `${window.location.origin}/join/${joinCode}` : null;

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-kp-text-primary flex-1 truncate">{title}</h2>
          <Badge variant={state === "in_progress" ? "success" : "neutral"}>
            {STATE_LABELS[state]}
          </Badge>
          {isPrivate && <Badge>private</Badge>}
          {snapshot && (
            <Badge variant={snapshot.driverConnected ? "success" : "warning"}>
              {snapshot.driverConnected ? "game online" : "game offline"}
            </Badge>
          )}
        </div>

        {state === "not_initialized" && session?.setupCode && (
          <div className="space-y-1">
            <div className="text-sm text-kp-text-secondary">Enter this setup code in your game:</div>
            <div
              className="text-3xl font-mono tracking-[0.3em] text-kp-text-primary"
              data-testid="setup-code"
            >
              {session.setupCode}
            </div>
          </div>
        )}

        {snapshot && !snapshot.driverConnected && state !== "not_initialized" && (
          <p className="text-sm text-kp-accent-warning" data-testid="driver-away-note">
            The game is offline. The session closes automatically if it does not reconnect
            within {DRIVER_LOST_MINUTES} minutes.
          </p>
        )}

        {isPrivate && state !== "not_initialized" && (
          <p className="text-sm text-kp-text-secondary" data-testid="private-note">
            Private: no join code. Players linked to its driver key join from their own list.
          </p>
        )}

        {joinCode && (
          <div className="space-y-1">
            <div className="text-sm text-kp-text-secondary">Players join with:</div>
            <div
              className="text-3xl font-mono tracking-[0.3em] text-kp-text-primary"
              data-testid="join-code"
            >
              {joinCode}
            </div>
            {joinLink && (
              <Button
                size="small"
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(joinLink)}
              >
                Copy join link
              </Button>
            )}
          </div>
        )}

        {snapshot && snapshot.players.length > 0 && (
          <PlayerList
            players={snapshot.players}
            showReady={state === "waiting_for_players"}
            onKick={(playerId) => kickMutation.mutate(playerId)}
          />
        )}
        {kickMutation.error && (
          <p className="text-sm text-kp-accent-danger">{kickMutation.error.message}</p>
        )}
        {snapshot && state === "waiting_for_players" && <MissingRoster snapshot={snapshot} />}

        <div className="flex gap-2">
          {confirmingEnd ? (
            <>
              <Button
                variant="danger"
                size="small"
                loading={endMutation.isPending}
                data-testid="confirm-end-session"
                onClick={() => endMutation.mutate()}
              >
                Yes, end it
              </Button>
              <Button variant="ghost" size="small" onClick={() => setConfirmingEnd(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="small"
              data-testid="end-session-button"
              onClick={() => setConfirmingEnd(true)}
            >
              End session
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};
