import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { PlayerHome } from "./PlayerHome.js";
import { PlayerSession } from "./PlayerSession.js";
import { clearStoredPlayer, loadStoredPlayer, type StoredPlayer } from "./player-storage.js";
import { useNoPinchZoom } from "./useViewportGuard.js";

export type PhoneAppProps = {
  /** Heading of the landing page. */
  title?: string;
  /** Rendered at the end of the heading row (e.g. the signed-in user). */
  header?: ReactNode;
  /** Rendered below the join form / stored session on the landing page. */
  landingExtra?: ReactNode;
};

/**
 * The whole player app in one component: "/" is the landing page
 * (`PlayerHome`), "/join/:code" prefills the join form (the link drivers
 * render as QR codes), "/play" is the controller. Needs `wouter` (an optional
 * peer dependency) and a `KapulaPlayerProvider` and QueryClientProvider above it.
 */
export const PhoneApp = ({ title = "Kapula", header, landingExtra }: PhoneAppProps) => {
  const [player, setPlayer] = useState(loadStoredPlayer);
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  useNoPinchZoom();

  const handleJoined = (joined: StoredPlayer) => {
    // The player must be committed before navigating: a "/play" render that
    // still sees a null player redirects straight back.
    flushSync(() => {
      setPlayer(joined);
      setLeaveMessage(null);
    });
    setLocation("/play");
  };
  const handleLeave = (message?: string) => {
    clearStoredPlayer();
    setPlayer(null);
    setLeaveMessage(message ?? null);
    setLocation("/", { replace: true });
  };
  const handleStalePlayer = () => {
    clearStoredPlayer();
    setPlayer(null);
  };

  const landing = (initialJoinCode: string) => (
    <div className="p-4 max-w-md mx-auto space-y-4">
      <div className="flex items-baseline gap-2">
        <h1 className="text-xl font-semibold text-kp-text-primary">{title}</h1>
        {header}
      </div>
      <PlayerHome
        initialJoinCode={initialJoinCode}
        player={player}
        leaveMessage={leaveMessage}
        onJoined={handleJoined}
        onStalePlayer={handleStalePlayer}
        onOpenController={() => setLocation("/play")}
      />
      {landingExtra}
    </div>
  );

  return (
    <Switch>
      <Route path="/play">
        {player ? (
          <PlayerSession player={player} onLeave={handleLeave} />
        ) : (
          <Redirect to="/" replace />
        )}
      </Route>
      <Route path="/join/:code">
        {(params) => landing(decodeURIComponent(params.code))}
      </Route>
      <Route path="/">{landing("")}</Route>
      <Route>
        <Redirect to="/" replace />
      </Route>
    </Switch>
  );
};
