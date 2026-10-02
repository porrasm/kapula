import type { IncomingMessage } from "http";
import { KAPULA_DRIVER_LOST_TIMEOUT_MS } from "@kapula/protocol";
import type { KapulaStore } from "./store.js";

/**
 * What the Kapula server needs from its host, besides a store: who the
 * logged-in user behind an HTTP request is (only the host WebSocket role
 * needs it — drivers and players authenticate with their own tokens), a
 * logger, and a few settings. A web host supplies its cookie auth, logger
 * and env-derived settings; an embedded host (a desktop app) supplies a
 * constant owner and defaults. See apps/host for the reference host.
 */

export type KapulaHostUser = {
  id: number;
  /** Lowercased; matched against the emails linked to driver keys (private sessions). */
  email: string;
};

export type KapulaAuth = {
  /** The user behind a request, for the host WebSocket; null when nobody. */
  getUserFromRequest(req: IncomingMessage): Promise<KapulaHostUser | null>;
};

export type KapulaLogger = {
  debug(message?: unknown, ...rest: unknown[]): void;
  info(message?: unknown, ...rest: unknown[]): void;
  warn(message?: unknown, ...rest: unknown[]): void;
  error(message?: unknown, ...rest: unknown[]): void;
};

export type KapulaServerConfig = {
  /**
   * Where the driver HTTP router is mounted; the WebSocket path and the
   * background image URLs hang off it.
   */
  basePath: string;
  /** Path of the player web app, for the join URLs drivers render as QR codes. */
  playerAppPath: string;
  /**
   * A fixed origin for the absolute URLs in the setup response (production:
   * the bare domain, which works for everyone); null derives one from each
   * request's Host header (dev).
   */
  publicOrigin: { host: string; secure: boolean } | null;
  /** How long a session survives without its driver. */
  driverLostTimeoutMs: number;
  /** WebSocket-level ping interval; a client silent for two ticks is terminated. */
  keepaliveIntervalMs: number;
  /**
   * Honour the `x-kapula-ratelimit-key` header as the rate-limit bucket
   * instead of the caller IP. Test suites sharing localhost need it; never
   * enable it in production — a spoofable header must not bypass the
   * brute-force guard.
   */
  allowRateLimitKeyHeader: boolean;
};

export const KAPULA_DEFAULT_CONFIG: KapulaServerConfig = {
  basePath: "/api/kapula",
  playerAppPath: "/kapula",
  publicOrigin: null,
  driverLostTimeoutMs: KAPULA_DRIVER_LOST_TIMEOUT_MS,
  keepaliveIntervalMs: 30_000,
  allowRateLimitKeyHeader: false,
};

export type KapulaContext = {
  store: KapulaStore;
  auth: KapulaAuth;
  logger: KapulaLogger;
  config: KapulaServerConfig;
};
