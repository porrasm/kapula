import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, PhoneApp } from "@kapula/phone";
import { HostPanel } from "./HostPanel";
import { fetchMe, loginWithToken, logout } from "./host-api";

/**
 * The reference host is `PhoneApp` plus its extras: the signed-in user in the
 * heading row, and below the join form either the host panel (logged in) or
 * the login form.
 */
export const App = () => <PhoneApp title="Kapula" header={<UserBadge />} landingExtra={<HostExtra />} />;

const UserBadge = () => {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const user = meQuery.data?.user;
  if (!user) return null;
  return (
    <span className="ml-auto text-xs text-kp-text-muted">
      {user.email}{" "}
      <button
        className="underline"
        type="button"
        onClick={() => logout().then(() => meQuery.refetch())}
      >
        log out
      </button>
    </span>
  );
};

const HostExtra = () => {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const me = meQuery.data ?? null;
  if (me?.user) return <HostPanel />;
  if (me) {
    return <Login devAuth={me.devAuth} ownerLogin={me.ownerLogin} onLoggedIn={() => meQuery.refetch()} />;
  }
  return null;
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
