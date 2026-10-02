import { useState } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Redirect, Route, Switch, useLocation } from "wouter";
import {
  Button,
  PlayerHome,
  PlayerSession,
  clearStoredPlayer,
  loadStoredPlayer,
  useNoPinchZoom,
  type StoredPlayer,
} from "@kapula/phone";
import { HostPanel } from "./HostPanel";
import { fetchMe, loginWithToken, logout } from "./host-api";

/**
 * Routes of the reference host: "/" is the landing page (join form or the
 * stored session, plus the host panel for a logged-in user), "/join/:code"
 * prefills the join form (the link drivers render as QR codes), "/play" is
 * the controller.
 */
export const App = () => {
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
    <Landing
      initialJoinCode={initialJoinCode}
      player={player}
      leaveMessage={leaveMessage}
      onJoined={handleJoined}
      onStalePlayer={handleStalePlayer}
    />
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

const Landing = ({
  initialJoinCode,
  player,
  leaveMessage,
  onJoined,
  onStalePlayer,
}: {
  initialJoinCode: string;
  player: StoredPlayer | null;
  leaveMessage: string | null;
  onJoined: (player: StoredPlayer) => void;
  onStalePlayer: () => void;
}) => {
  const [, navigate] = useLocation();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const me = meQuery.data ?? null;

  return (
    <div className="p-4 max-w-md mx-auto space-y-4">
      <div className="flex items-baseline gap-2">
        <h1 className="text-xl font-semibold text-kp-text-primary">Kapula</h1>
        {me?.user && (
          <span className="ml-auto text-xs text-kp-text-muted">
            {me.user.email}{" "}
            <button
              className="underline"
              type="button"
              onClick={() => logout().then(() => meQuery.refetch())}
            >
              log out
            </button>
          </span>
        )}
      </div>

      <PlayerHome
        initialJoinCode={initialJoinCode}
        player={player}
        leaveMessage={leaveMessage}
        onJoined={onJoined}
        onStalePlayer={onStalePlayer}
        onOpenController={() => navigate("/play")}
      />

      {me?.user ? (
        <HostPanel />
      ) : me ? (
        <Login devAuth={me.devAuth} ownerLogin={me.ownerLogin} onLoggedIn={() => meQuery.refetch()} />
      ) : null}
    </div>
  );
};

/** Dev: any email. Owner: the configured token. Neither: hosting is off. */
const Login = ({
  devAuth,
  ownerLogin,
  onLoggedIn,
}: {
  devAuth: boolean;
  ownerLogin: boolean;
  onLoggedIn: () => void;
}) => {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!devAuth && !ownerLogin) {
    return (
      <p className="text-sm text-kp-text-secondary">
        Hosting is off on this server: set KAPULA_OWNER_TOKEN (or
        KAPULA_DEV_AUTH=1 for development) to create sessions here.
      </p>
    );
  }
  return (
    <div className="rounded-kp bg-kp-bg-secondary p-3 space-y-2">
      <p className="text-sm text-kp-text-secondary">Want to host a session? Log in.</p>
      {devAuth && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            window.location.assign(`/auth/dev-login?email=${encodeURIComponent(email)}`);
          }}
        >
          <input
            className="flex-1 rounded-kp bg-kp-bg-tertiary border border-kp-border px-3 py-2 text-kp-text-primary"
            placeholder="dev login: any email"
            value={email}
            data-testid="dev-login-email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" size="small" data-testid="dev-login-button">
            Log in
          </Button>
        </form>
      )}
      {ownerLogin && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            loginWithToken(token).then(onLoggedIn, (err: Error) => setError(err.message));
          }}
        >
          <input
            className="flex-1 rounded-kp bg-kp-bg-tertiary border border-kp-border px-3 py-2 text-kp-text-primary"
            placeholder="owner token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" size="small">
            Log in
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-kp-accent-danger">{error}</p>}
    </div>
  );
};
