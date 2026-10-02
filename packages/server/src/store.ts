import type { KapulaSessionState } from "@kapula/protocol";

/**
 * The persistence contract of the Kapula server. Everything the server
 * keeps between requests — sessions, players, driver keys, background images
 * — goes through this interface, so the server itself has no database
 * dependency: the monorepo plugs in Postgres (`postgres-store.ts`, over the
 * piquel operations), an embedded host (a desktop app) plugs in the
 * in-memory store (`memory-store.ts`).
 *
 * Semantics every implementation must honour (the conformance suite in
 * `tests/unit/gamepad-store-conformance.ts` checks them):
 *
 * - "Active" means not ended (sessions) or not left (players). Lookups by
 *   code, token or key only ever find active rows; ended and left rows are
 *   invisible except through the ids they already handed out.
 * - Uniqueness among active rows: a session's setup code, join code and
 *   driver token; a player's token, and per session a player's color and
 *   name (case-insensitive); a driver key's hash; a background key. A
 *   violation throws {@link KapulaStoreConflictError} — callers retry with
 *   a fresh code or report "taken".
 * - Elapsed time is the store's to measure (`getDriverAwayMs`,
 *   `endInactiveSessions`): a database compares its own clock against its
 *   own timestamps, and the in-memory store takes an injectable clock.
 *   Records expose no activity timestamps for that reason.
 */

export type KapulaSessionRecord = {
  id: string;
  ownerId: number;
  state: KapulaSessionState;
  /** Single-use; null once the driver's setup call consumed it. */
  setupCode: string | null;
  /** Set at driver setup; what players type to join. */
  joinCode: string | null;
  driverToken: string | null;
  /** The session config as given at setup (JSON); null until then. */
  config: Record<string, unknown> | null;
  /** Free-form text the host attached; handed to the driver verbatim. */
  metadata: string | null;
  /** The driver key that created it; null for a session hosted on the web. */
  driverKeyId: number | null;
  /**
   * Whether the driver-away clock is running: no driver socket since setup,
   * or since the last drop. Cleared when a driver socket connects.
   */
  driverAway: boolean;
  createdAt: Date;
};

export type KapulaPlayerRecord = {
  id: string;
  sessionId: string;
  name: string;
  color: string;
  /** Capability token the phone stores for reconnecting. */
  token: string;
  schemaId: string | null;
  ready: boolean;
  createdAt: Date;
};

export type KapulaDriverKeyRecord = {
  id: number;
  userId: number;
  name: string;
  /** First characters of the plain key, for recognizing it in a list. */
  prefix: string;
  /** Lowercased emails that may join the key's private sessions. */
  linkedEmails: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** A private session with the name of the driver key that opened it. */
export type KapulaPrivateSessionRecord = KapulaSessionRecord & {
  keyName: string | null;
};

/** Everything but the image itself: what snapshots and broadcasts need. */
export type KapulaBackgroundMeta = { key: string; fit: string };

export type KapulaBackgroundImage = {
  contentType: string;
  /** The image bytes, base64-encoded. */
  data: string;
};

/** A uniqueness rule was violated; see the contract above for the rules. */
export class KapulaStoreConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "KapulaStoreConflictError";
  }
}

export const isStoreConflict = (e: unknown): e is KapulaStoreConflictError =>
  e instanceof KapulaStoreConflictError;

export interface KapulaStore {
  // --- Sessions ---

  /** Throws a conflict when `setupCode` is already an active session's. */
  createSession(params: {
    ownerId: number;
    setupCode: string;
    metadata: string | null;
    driverKeyId?: number | null;
  }): Promise<KapulaSessionRecord>;

  /**
   * The owner's web-hosted session (created with a setup code, not by a
   * driver key) — the one slot the host page manages. At most one is active.
   */
  getActiveHostedSessionByOwner(ownerId: number): Promise<KapulaSessionRecord | null>;

  /** The session a driver key has open; at most one is active per key. */
  getActiveSessionByDriverKey(keyId: number): Promise<KapulaSessionRecord | null>;

  /** Every active session the user owns: hosted first, then by age. */
  getActiveSessionsByOwner(ownerId: number): Promise<KapulaSessionRecord[]>;

  getActiveSessionById(sessionId: string): Promise<KapulaSessionRecord | null>;
  getActiveSessionBySetupCode(setupCode: string): Promise<KapulaSessionRecord | null>;
  getActiveSessionByJoinCode(joinCode: string): Promise<KapulaSessionRecord | null>;
  getActiveSessionByDriverToken(driverToken: string): Promise<KapulaSessionRecord | null>;

  /**
   * Driver setup: consumes the setup code, opens the session for players
   * (state `waiting_for_players`) and starts the driver-away clock — the
   * driver has the token but no socket yet. Returns null when the session is
   * not active and `not_initialized` (claimed by someone else in between).
   * Throws a conflict when `joinCode` is already an active session's.
   */
  setupSession(params: {
    sessionId: string;
    joinCode: string;
    driverToken: string;
    config: Record<string, unknown>;
  }): Promise<KapulaSessionRecord | null>;

  /** Also counts as activity. Null when the session is not active. */
  updateSessionState(params: {
    sessionId: string;
    state: KapulaSessionState;
  }): Promise<KapulaSessionRecord | null>;

  /** Marks the session active now (the 24 h idle clock). */
  touchSessionActivity(sessionId: string): Promise<void>;

  /** Driver socket opened: stop the driver-away clock. */
  markDriverConnected(sessionId: string): Promise<void>;

  /** Driver socket closed: start the driver-away clock (keeps an earlier start). */
  markDriverDisconnected(sessionId: string): Promise<void>;

  /**
   * How long the driver has been away, in milliseconds, by the store's own
   * clock; null when the session is not active or the driver is not away.
   */
  getDriverAwayMs(sessionId: string): Promise<number | null>;

  /**
   * Server boot: every driver socket died with the old process, so any live,
   * initialized session whose driver was connected is driver-less now.
   * Starts their clocks; returns how many.
   */
  markAllDriversDisconnected(): Promise<number>;

  /** Null when it was already ended. */
  endSession(sessionId: string): Promise<KapulaSessionRecord | null>;

  /**
   * Ends sessions idle for 24 hours, `not_initialized` sessions idle for 30
   * minutes, and initialized sessions whose driver has been away longer than
   * `driverLostMs`. Returns the ended ones with the reason, for announcing.
   */
  endInactiveSessions(params: {
    driverLostMs: number;
  }): Promise<{ sessionId: string; driverLost: boolean }[]>;

  // --- Players ---

  /** Throws a conflict when the name, color or token is taken (see rules). */
  insertPlayer(params: {
    sessionId: string;
    name: string;
    color: string;
    token: string;
    schemaId: string;
  }): Promise<KapulaPlayerRecord>;

  /** In join order. */
  getActivePlayersBySession(sessionId: string): Promise<KapulaPlayerRecord[]>;
  getActivePlayerByToken(token: string): Promise<KapulaPlayerRecord | null>;

  /**
   * Marks the player as left: the name and color are immediately reusable
   * and the token goes dead. Null when the player was already gone.
   */
  markPlayerLeft(playerId: string): Promise<KapulaPlayerRecord | null>;

  /** Clears every active player's ready flag; returns the ones that changed. */
  clearReadyBySession(sessionId: string): Promise<KapulaPlayerRecord[]>;

  updatePlayerReady(params: {
    playerId: string;
    ready: boolean;
  }): Promise<KapulaPlayerRecord | null>;

  /** Throws a conflict when another active player of the session holds the name or color. */
  updatePlayerProfile(params: {
    playerId: string;
    name: string;
    color: string;
  }): Promise<KapulaPlayerRecord | null>;

  updatePlayerSchema(params: {
    playerId: string;
    schemaId: string;
  }): Promise<KapulaPlayerRecord | null>;

  // --- Driver keys ---

  /** Throws a conflict when the hash exists (vanishingly unlikely). */
  insertDriverKey(params: {
    userId: number;
    name: string;
    /** SHA-256 of the plain key; the plain value is never stored. */
    hash: string;
    prefix: string;
    linkedEmails: string[];
  }): Promise<KapulaDriverKeyRecord>;

  /** Live (unrevoked) keys, newest first. */
  getDriverKeysByUser(userId: number): Promise<KapulaDriverKeyRecord[]>;

  /** Live keys only; a revoked key does not match. */
  getLiveDriverKeyByHash(hash: string): Promise<KapulaDriverKeyRecord | null>;

  touchDriverKeyUsed(keyId: number): Promise<void>;

  /** Owner-scoped; null when the key is not the user's live key. */
  setDriverKeyLinkedEmails(params: {
    keyId: number;
    userId: number;
    linkedEmails: string[];
  }): Promise<KapulaDriverKeyRecord | null>;

  /** Owner-scoped and permanent; false when nothing was revoked. */
  revokeDriverKey(params: { keyId: number; userId: number }): Promise<boolean>;

  // --- Private sessions ---

  /**
   * Private sessions a user may join: active, initialized, `private` in
   * their config, and either the user's own or opened by a live driver key
   * that lists the user's email. In creation order. `sessionId` narrows the
   * list to one session (the access check at join).
   */
  getPrivateSessionsForUser(params: {
    userId: number;
    email: string;
    sessionId?: string | null;
  }): Promise<KapulaPrivateSessionRecord[]>;

  // --- Driver background image ---

  /** One image per session: a new upload replaces the old one and its key. */
  upsertSessionBackground(params: {
    sessionId: string;
    key: string;
    contentType: string;
    fit: string;
    data: string;
  }): Promise<KapulaBackgroundMeta>;

  /** Null when the session had none. */
  deleteSessionBackground(sessionId: string): Promise<KapulaBackgroundMeta | null>;
  getSessionBackgroundMeta(sessionId: string): Promise<KapulaBackgroundMeta | null>;

  /** The image behind a key, only while its session is active. */
  getLiveBackgroundByKey(key: string): Promise<KapulaBackgroundImage | null>;

  /** Drops the images of ended sessions; returns how many. */
  deleteEndedSessionBackgrounds(): Promise<number>;
}
