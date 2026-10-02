import {
  GamepadStoreConflictError,
  type GamepadBackgroundImage,
  type GamepadBackgroundMeta,
  type GamepadDriverKeyRecord,
  type GamepadPlayerRecord,
  type GamepadPrivateSessionRecord,
  type GamepadSessionRecord,
  type GamepadStore,
} from "./store.js";

/**
 * The `GamepadStore` contract in process memory: for an embedded host (a
 * desktop app hosting its own phones) and for tests. Sessions are ephemeral
 * by nature — a host that restarts simply creates new ones — so nothing is
 * written anywhere. The clock is injectable so the time rules (idle and
 * driver-lost ends, driver-away measurement) can be tested without waiting.
 *
 * Ids are decimal strings (sessions, players) and integers (driver keys)
 * like the Postgres serials, so clients that validate id shapes see no
 * difference.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_INITIALIZED_IDLE_MS = 30 * 60 * 1000;

type SessionRow = {
  id: string;
  ownerId: number;
  state: GamepadSessionRecord["state"];
  setupCode: string | null;
  joinCode: string | null;
  driverToken: string | null;
  config: Record<string, unknown> | null;
  metadata: string | null;
  driverKeyId: number | null;
  createdAt: number;
  lastActivityAt: number;
  driverDisconnectedAt: number | null;
  endedAt: number | null;
};

type PlayerRow = {
  id: string;
  sessionId: string;
  name: string;
  color: string;
  token: string;
  schemaId: string | null;
  ready: boolean;
  createdAt: number;
  leftAt: number | null;
};

type KeyRow = {
  id: number;
  userId: number;
  name: string;
  hash: string;
  prefix: string;
  linkedEmails: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type BackgroundRow = {
  sessionId: string;
  key: string;
  contentType: string;
  fit: string;
  data: string;
};

const conflict = (what: string) => new GamepadStoreConflictError(`${what} is taken`);

/** What a JSON column does to a value: drops undefined, stringifies dates. */
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const createMemoryGamepadStore = (options: {
  /** The store's clock, in milliseconds; defaults to `Date.now`. */
  now?: () => number;
} = {}): GamepadStore => {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionRow>();
  const players = new Map<string, PlayerRow>();
  const keys = new Map<number, KeyRow>();
  const backgrounds = new Map<string, BackgroundRow>();
  let nextSessionId = 1;
  let nextPlayerId = 1;
  let nextKeyId = 1;

  const toSession = (row: SessionRow): GamepadSessionRecord => ({
    id: row.id,
    ownerId: row.ownerId,
    state: row.state,
    setupCode: row.setupCode,
    joinCode: row.joinCode,
    driverToken: row.driverToken,
    config: row.config === null ? null : jsonClone(row.config),
    metadata: row.metadata,
    driverKeyId: row.driverKeyId,
    driverAway: row.driverDisconnectedAt !== null,
    createdAt: new Date(row.createdAt),
  });

  const toPlayer = (row: PlayerRow): GamepadPlayerRecord => ({
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    color: row.color,
    token: row.token,
    schemaId: row.schemaId,
    ready: row.ready,
    createdAt: new Date(row.createdAt),
  });

  const toKey = (row: KeyRow): GamepadDriverKeyRecord => ({
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    linkedEmails: [...row.linkedEmails],
    createdAt: new Date(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
  });

  const toBackgroundMeta = (row: BackgroundRow): GamepadBackgroundMeta => ({
    key: row.key,
    fit: row.fit,
  });

  const activeSessions = () =>
    [...sessions.values()].filter((row) => row.endedAt === null);
  const activeSession = (id: string): SessionRow | null => {
    const row = sessions.get(id);
    return row && row.endedAt === null ? row : null;
  };
  const findActiveSession = (pred: (row: SessionRow) => boolean) =>
    activeSessions().find(pred) ?? null;

  const activePlayers = () =>
    [...players.values()].filter((row) => row.leftAt === null);
  const activePlayer = (id: string): PlayerRow | null => {
    const row = players.get(id);
    return row && row.leftAt === null ? row : null;
  };
  const activePlayersOf = (sessionId: string) =>
    activePlayers()
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));

  /** The per-session uniqueness of a player's name (case-insensitive) and color. */
  const assertPlayerSlotFree = (
    sessionId: string,
    name: string,
    color: string,
    exceptPlayerId: string | null,
  ) => {
    for (const other of activePlayersOf(sessionId)) {
      if (other.id === exceptPlayerId) continue;
      if (other.name.toLowerCase() === name.toLowerCase()) throw conflict("Name");
      if (other.color === color) throw conflict("Color");
    }
  };

  const byCreation = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
    a.createdAt - b.createdAt || Number(a.id) - Number(b.id);

  return {
    // --- Sessions ---

    createSession: async ({ ownerId, setupCode, metadata, driverKeyId = null }) => {
      if (findActiveSession((row) => row.setupCode === setupCode)) {
        throw conflict("Setup code");
      }
      const at = now();
      const row: SessionRow = {
        id: String(nextSessionId++),
        ownerId,
        state: "not_initialized",
        setupCode,
        joinCode: null,
        driverToken: null,
        config: null,
        metadata,
        driverKeyId,
        createdAt: at,
        lastActivityAt: at,
        driverDisconnectedAt: null,
        endedAt: null,
      };
      sessions.set(row.id, row);
      return toSession(row);
    },
    getActiveHostedSessionByOwner: async (ownerId) => {
      const row = findActiveSession(
        (s) => s.ownerId === ownerId && s.driverKeyId === null,
      );
      return row && toSession(row);
    },
    getActiveSessionByDriverKey: async (keyId) => {
      const row = findActiveSession((s) => s.driverKeyId === keyId);
      return row && toSession(row);
    },
    getActiveSessionsByOwner: async (ownerId) =>
      activeSessions()
        .filter((s) => s.ownerId === ownerId)
        .sort(
          (a, b) =>
            Number(a.driverKeyId !== null) - Number(b.driverKeyId !== null) ||
            byCreation(a, b),
        )
        .map(toSession),
    getActiveSessionById: async (sessionId) => {
      const row = activeSession(sessionId);
      return row && toSession(row);
    },
    getActiveSessionBySetupCode: async (setupCode) => {
      const row = findActiveSession((s) => s.setupCode === setupCode);
      return row && toSession(row);
    },
    getActiveSessionByJoinCode: async (joinCode) => {
      const row = findActiveSession((s) => s.joinCode === joinCode);
      return row && toSession(row);
    },
    getActiveSessionByDriverToken: async (driverToken) => {
      const row = findActiveSession((s) => s.driverToken === driverToken);
      return row && toSession(row);
    },
    setupSession: async ({ sessionId, joinCode, driverToken, config }) => {
      const row = activeSession(sessionId);
      if (!row || row.state !== "not_initialized") return null;
      if (findActiveSession((s) => s.joinCode === joinCode)) throw conflict("Join code");
      if (findActiveSession((s) => s.driverToken === driverToken)) {
        throw conflict("Driver token");
      }
      const at = now();
      row.state = "waiting_for_players";
      row.setupCode = null;
      row.joinCode = joinCode;
      row.driverToken = driverToken;
      row.config = jsonClone(config);
      row.driverDisconnectedAt = at;
      row.lastActivityAt = at;
      return toSession(row);
    },
    updateSessionState: async ({ sessionId, state }) => {
      const row = activeSession(sessionId);
      if (!row) return null;
      row.state = state;
      row.lastActivityAt = now();
      return toSession(row);
    },
    touchSessionActivity: async (sessionId) => {
      const row = activeSession(sessionId);
      if (row) row.lastActivityAt = now();
    },
    markDriverConnected: async (sessionId) => {
      const row = activeSession(sessionId);
      if (row) row.driverDisconnectedAt = null;
    },
    markDriverDisconnected: async (sessionId) => {
      const row = activeSession(sessionId);
      if (row && row.driverDisconnectedAt === null) row.driverDisconnectedAt = now();
    },
    getDriverAwayMs: async (sessionId) => {
      const row = activeSession(sessionId);
      if (!row || row.driverDisconnectedAt === null) return null;
      return now() - row.driverDisconnectedAt;
    },
    markAllDriversDisconnected: async () => {
      const at = now();
      let count = 0;
      for (const row of activeSessions()) {
        if (row.state === "not_initialized" || row.driverDisconnectedAt !== null) continue;
        row.driverDisconnectedAt = at;
        count += 1;
      }
      return count;
    },
    endSession: async (sessionId) => {
      const row = activeSession(sessionId);
      if (!row) return null;
      row.state = "ended";
      row.endedAt = now();
      return toSession(row);
    },
    endInactiveSessions: async ({ driverLostMs }) => {
      const at = now();
      const ended: { sessionId: string; driverLost: boolean }[] = [];
      for (const row of activeSessions()) {
        const idle = row.lastActivityAt < at - DAY_MS;
        const unclaimed =
          row.state === "not_initialized" &&
          row.lastActivityAt < at - NOT_INITIALIZED_IDLE_MS;
        const driverLost =
          row.state !== "not_initialized" &&
          row.driverDisconnectedAt !== null &&
          row.driverDisconnectedAt < at - driverLostMs;
        if (!idle && !unclaimed && !driverLost) continue;
        row.state = "ended";
        row.endedAt = at;
        ended.push({ sessionId: row.id, driverLost });
      }
      return ended;
    },

    // --- Players ---

    insertPlayer: async ({ sessionId, name, color, token, schemaId }) => {
      if (activePlayers().some((p) => p.token === token)) throw conflict("Token");
      assertPlayerSlotFree(sessionId, name, color, null);
      const row: PlayerRow = {
        id: String(nextPlayerId++),
        sessionId,
        name,
        color,
        token,
        schemaId,
        ready: false,
        createdAt: now(),
        leftAt: null,
      };
      players.set(row.id, row);
      return toPlayer(row);
    },
    getActivePlayersBySession: async (sessionId) => activePlayersOf(sessionId).map(toPlayer),
    getActivePlayerByToken: async (token) => {
      const row = activePlayers().find((p) => p.token === token) ?? null;
      return row && toPlayer(row);
    },
    markPlayerLeft: async (playerId) => {
      const row = activePlayer(playerId);
      if (!row) return null;
      row.leftAt = now();
      return toPlayer(row);
    },
    clearReadyBySession: async (sessionId) => {
      const changed: GamepadPlayerRecord[] = [];
      for (const row of activePlayersOf(sessionId)) {
        if (!row.ready) continue;
        row.ready = false;
        changed.push(toPlayer(row));
      }
      return changed;
    },
    updatePlayerReady: async ({ playerId, ready }) => {
      const row = activePlayer(playerId);
      if (!row) return null;
      row.ready = ready;
      return toPlayer(row);
    },
    updatePlayerProfile: async ({ playerId, name, color }) => {
      const row = activePlayer(playerId);
      if (!row) return null;
      assertPlayerSlotFree(row.sessionId, name, color, row.id);
      row.name = name;
      row.color = color;
      return toPlayer(row);
    },
    updatePlayerSchema: async ({ playerId, schemaId }) => {
      const row = activePlayer(playerId);
      if (!row) return null;
      row.schemaId = schemaId;
      return toPlayer(row);
    },

    // --- Driver keys ---

    insertDriverKey: async ({ userId, name, hash, prefix, linkedEmails }) => {
      if ([...keys.values()].some((k) => k.hash === hash)) throw conflict("Key hash");
      const row: KeyRow = {
        id: nextKeyId++,
        userId,
        name,
        hash,
        prefix,
        linkedEmails: [...linkedEmails],
        createdAt: now(),
        lastUsedAt: null,
        revokedAt: null,
      };
      keys.set(row.id, row);
      return toKey(row);
    },
    getDriverKeysByUser: async (userId) =>
      [...keys.values()]
        .filter((k) => k.userId === userId && k.revokedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .map(toKey),
    getLiveDriverKeyByHash: async (hash) => {
      const row =
        [...keys.values()].find((k) => k.hash === hash && k.revokedAt === null) ?? null;
      return row && toKey(row);
    },
    touchDriverKeyUsed: async (keyId) => {
      const row = keys.get(keyId);
      if (row) row.lastUsedAt = now();
    },
    setDriverKeyLinkedEmails: async ({ keyId, userId, linkedEmails }) => {
      const row = keys.get(keyId);
      if (!row || row.userId !== userId || row.revokedAt !== null) return null;
      row.linkedEmails = [...linkedEmails];
      return toKey(row);
    },
    revokeDriverKey: async ({ keyId, userId }) => {
      const row = keys.get(keyId);
      if (!row || row.userId !== userId || row.revokedAt !== null) return false;
      row.revokedAt = now();
      return true;
    },

    // --- Private sessions ---

    getPrivateSessionsForUser: async ({ userId, email, sessionId = null }) => {
      const result: GamepadPrivateSessionRecord[] = [];
      for (const row of activeSessions().sort(byCreation)) {
        if (row.state === "not_initialized") continue;
        if (row.config?.private !== true) continue;
        if (sessionId !== null && row.id !== sessionId) continue;
        const key = row.driverKeyId === null ? null : (keys.get(row.driverKeyId) ?? null);
        const linked =
          key !== null && key.revokedAt === null && key.linkedEmails.includes(email);
        if (row.ownerId !== userId && !linked) continue;
        result.push({ ...toSession(row), keyName: key?.name ?? null });
      }
      return result;
    },

    // --- Driver background image ---

    upsertSessionBackground: async ({ sessionId, key, contentType, fit, data }) => {
      for (const [otherSessionId, other] of backgrounds) {
        if (other.key === key && otherSessionId !== sessionId) throw conflict("Background key");
      }
      const row: BackgroundRow = { sessionId, key, contentType, fit, data };
      backgrounds.set(sessionId, row);
      return toBackgroundMeta(row);
    },
    deleteSessionBackground: async (sessionId) => {
      const row = backgrounds.get(sessionId);
      if (!row) return null;
      backgrounds.delete(sessionId);
      return toBackgroundMeta(row);
    },
    getSessionBackgroundMeta: async (sessionId) => {
      const row = backgrounds.get(sessionId);
      return row ? toBackgroundMeta(row) : null;
    },
    getLiveBackgroundByKey: async (key): Promise<GamepadBackgroundImage | null> => {
      for (const row of backgrounds.values()) {
        if (row.key !== key) continue;
        if (!activeSession(row.sessionId)) return null;
        return { contentType: row.contentType, data: row.data };
      }
      return null;
    },
    deleteEndedSessionBackgrounds: async () => {
      let count = 0;
      for (const sessionId of [...backgrounds.keys()]) {
        if (activeSession(sessionId)) continue;
        backgrounds.delete(sessionId);
        count += 1;
      }
      return count;
    },
  };
};
