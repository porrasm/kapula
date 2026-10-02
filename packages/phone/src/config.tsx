import { createContext, useContext, type ReactNode } from "react";
import "./kapula.css";

/**
 * Where the player screens find their server. The phone UI is mounted by a
 * host page — the monorepo's Kapula app today, a desktop app's built-in
 * server later — and the host says where the Kapula HTTP API lives; the
 * screens derive every URL from that. Nothing in this folder may hardcode a
 * path or import from the host (tests/unit/gamepad-player-boundary.spec.ts
 * enforces it).
 */
export type KapulaPlayerConfig = {
  /**
   * Base of the Kapula HTTP API without a trailing slash: a path on the same
   * origin ("/api/gamepad") or an absolute URL. The player routes and the
   * session WebSocket hang under it ("<apiBase>/join", "<apiBase>/ws").
   */
  apiBase: string;
};

export const KAPULA_PLAYER_DEFAULTS: KapulaPlayerConfig = {
  apiBase: "/api/gamepad",
};

const ConfigContext = createContext<KapulaPlayerConfig>(KAPULA_PLAYER_DEFAULTS);

/** Mount once around the player screens; omitted values keep the defaults. */
export const KapulaPlayerProvider = ({
  config,
  children,
}: {
  config: Partial<KapulaPlayerConfig>;
  children: ReactNode;
}) => (
  <ConfigContext.Provider
    value={{ apiBase: config.apiBase ?? KAPULA_PLAYER_DEFAULTS.apiBase }}
  >
    {children}
  </ConfigContext.Provider>
);

export const useKapulaConfig = (): KapulaPlayerConfig => useContext(ConfigContext);

/**
 * The session WebSocket under the API base, ws(s) matching http(s). Resolved
 * against the page so a relative `apiBase` works wherever the page is served.
 */
export const buildKapulaWsUrl = (
  apiBase: string,
  params: Record<string, string>,
): string => {
  const url = new URL(`${apiBase}/ws`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams(params).toString();
  return url.toString();
};
