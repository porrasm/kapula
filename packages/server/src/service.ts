import {
  kapulaSessionStateSchema,
  getSessionColors,
  type KapulaJoinInfo,
  type KapulaJoinResult,
  type KapulaPlayerStatus,
  type KapulaSessionState,
} from "@kapula/protocol";
import type { KapulaContext } from "./context.js";
import {
  acceptsJoins,
  driverKeyDisplayPrefix,
  generateDriverKey,
  generateKapulaCode,
  generateKapulaToken,
  getJoinError,
  hashDriverKey,
  pickDefaultColor,
  pickDefaultName,
  pickRosterSlot,
} from "./logic.js";
import { parseSessionConfig, type SessionRuntimes } from "./runtime.js";
import {
  isStoreConflict,
  type KapulaDriverKeyRecord,
  type KapulaSessionRecord,
} from "./store.js";

/**
 * What the host page and the player phone do over HTTP, free of any web
 * framework: the monorepo wraps these in its own RPC layer (the monorepo: tRPC), an
 * embedded host calls them directly or behind its own routes. Failures are
 * {@link KapulaServiceError}s with a code the wrapper maps to its own
 * status codes.
 */

export type KapulaServiceErrorCode = "not_found" | "conflict";

export class KapulaServiceError extends Error {
  readonly code: KapulaServiceErrorCode;
  constructor(code: KapulaServiceErrorCode, message: string) {
    super(message);
    this.name = "KapulaServiceError";
    this.code = code;
  }
}

const notFound = (message: string) => new KapulaServiceError("not_found", message);
const conflict = (message: string) => new KapulaServiceError("conflict", message);

/** Retries against the uniqueness of active codes. */
const withCodeRetry = async <T>(
  attempt: (code: string) => Promise<T>,
): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await attempt(generateKapulaCode());
    } catch (e) {
      if (!isStoreConflict(e) || i >= 4) throw e;
    }
  }
};

/** What the host page shows of one of the user's sessions. */
export type KapulaMySession = {
  sessionId: string;
  state: KapulaSessionState;
  setupCode: string | null;
  joinCode: string | null;
  metadata: string | null;
  config: ReturnType<typeof parseSessionConfig> | null;
  createdAt: Date;
  /** Joinable only from the private list, never with the join code. */
  private: boolean;
  /** The driver key that opened it; null for the web-hosted session. */
  driverKeyId: number | null;
  driverKeyName: string | null;
};

const toMySession = (
  session: KapulaSessionRecord,
  keyNames: Map<number, string>,
): KapulaMySession => ({
  sessionId: session.id,
  state: session.state,
  setupCode: session.setupCode,
  joinCode: session.joinCode,
  metadata: session.metadata,
  config: session.config ? parseSessionConfig(session) : null,
  createdAt: session.createdAt,
  private: session.config ? parseSessionConfig(session).private : false,
  driverKeyId: session.driverKeyId,
  driverKeyName:
    session.driverKeyId === null
      ? null
      : (keyNames.get(session.driverKeyId) ?? null),
});

const toDriverKeyInfo = (key: KapulaDriverKeyRecord) => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  createdAt: key.createdAt,
  lastUsedAt: key.lastUsedAt,
  /** Who besides the owner may join the key's private sessions. */
  linkedEmails: key.linkedEmails,
});

export const createKapulaService = (
  ctx: KapulaContext,
  runtimes: SessionRuntimes,
) => {
  const { store, logger } = ctx;

  /**
   * The session a host action targets: the given one when it is the
   * caller's, else (no id) the caller's web-hosted session — what older
   * clients mean.
   */
  const findOwnedSession = async (
    ownerId: number,
    sessionId: string | undefined,
  ): Promise<KapulaSessionRecord | null> => {
    if (sessionId === undefined) {
      return store.getActiveHostedSessionByOwner(ownerId);
    }
    const session = await store.getActiveSessionById(sessionId);
    return session && session.ownerId === ownerId ? session : null;
  };

  /**
   * A code-joinable session by its join code. Private sessions are not: to
   * the join-code path they do not exist, so a code cannot even confirm one.
   */
  const findPublicSessionByJoinCode = async (
    joinCode: string,
  ): Promise<KapulaSessionRecord | null> => {
    const session = await store.getActiveSessionByJoinCode(joinCode);
    if (!session || parseSessionConfig(session).private) return null;
    return session;
  };

  /**
   * Adds a player to a session the caller is allowed into: the server
   * assigns a free "Player N" name and the first free color (or, in a roster
   * session, the slot `name` picks), and announces the join.
   */
  const joinPlayer = async (
    session: KapulaSessionRecord,
    requestedName: string | undefined,
  ): Promise<KapulaJoinResult> => {
    const config = parseSessionConfig(session);
    const runtime = runtimes.getRuntime(session);

    // The store's uniqueness rules are the backstop for join races;
    // re-picking defaults on a conflict resolves two players grabbing the
    // same slot.
    for (let attempt = 0; ; attempt++) {
      const players = await store.getActivePlayersBySession(session.id);
      const joinError = getJoinError({
        state: runtime.state,
        config,
        activePlayers: players,
      });
      if (joinError) throw conflict(joinError);

      let name: string;
      let color: string;
      if (config.roster) {
        const picked = pickRosterSlot({
          config,
          activePlayers: players.map((p) => ({ name: p.name })),
          name: requestedName,
        });
        if ("error" in picked) throw conflict(picked.error);
        name = picked.slot.name;
        color = picked.slot.color;
      } else {
        const picked = pickDefaultColor(
          config,
          players.map((p) => p.color),
        );
        if (!picked) throw conflict("The session is full");
        color = picked;
        name = pickDefaultName(
          players.map((p) => p.name),
          requestedName,
        );
      }

      try {
        const player = await store.insertPlayer({
          sessionId: session.id,
          name,
          color,
          token: generateKapulaToken(),
          schemaId: config.schemas[0].id,
        });
        runtimes.notifyPlayerJoined(session, player);
        return {
          sessionId: session.id,
          playerId: player.id,
          playerToken: player.token,
        };
      } catch (e) {
        if (isStoreConflict(e) && attempt < 4) continue;
        logger.error("[kapula] join failed", e);
        throw e;
      }
    }
  };

  return {
    /** One hosted session per user; sessions opened by driver keys have slots of their own. */
    createHostedSession: async (params: {
      ownerId: number;
      /** Free-form text handed to the driver at setup (e.g. game config). */
      metadata?: string;
    }) => {
      const existing = await store.getActiveHostedSessionByOwner(params.ownerId);
      if (existing) {
        throw conflict("You already have an active session. End it first.");
      }
      const session = await withCodeRetry((setupCode) =>
        store.createSession({
          ownerId: params.ownerId,
          setupCode,
          metadata: params.metadata ?? null,
        }),
      );
      return {
        sessionId: session.id,
        setupCode: session.setupCode,
        state: session.state,
      };
    },

    /**
     * Driver keys let a standalone driver create its own session without a
     * host in a browser (see KAPULA.md "Driver keys"). The plain key is
     * returned exactly once, here — only its hash is stored.
     */
    createDriverKey: async (params: {
      userId: number;
      name: string;
      linkedEmails?: string[];
    }) => {
      const key = generateDriverKey();
      const record = await store.insertDriverKey({
        userId: params.userId,
        name: params.name,
        hash: hashDriverKey(key),
        prefix: driverKeyDisplayPrefix(key),
        linkedEmails: params.linkedEmails ?? [],
      });
      return {
        ...toDriverKeyInfo(record),
        /** Shown once and never recoverable; the user must store it now. */
        key,
      };
    },

    listDriverKeys: async (userId: number) =>
      (await store.getDriverKeysByUser(userId)).map(toDriverKeyInfo),

    /**
     * Replaces the emails linked to a key — who besides the owner may join
     * the private sessions it opens. Checked at join time: a removed email
     * cannot join again, but a player already in keeps playing until they
     * leave or the host kicks them.
     */
    setDriverKeyEmails: async (params: {
      userId: number;
      keyId: number;
      linkedEmails: string[];
    }) => {
      const record = await store.setDriverKeyLinkedEmails(params);
      if (!record) throw notFound("Key not found");
      return toDriverKeyInfo(record);
    },

    revokeDriverKey: async (params: { userId: number; keyId: number }) => {
      const revoked = await store.revokeDriverKey(params);
      if (!revoked) throw notFound("Key not found");
    },

    /**
     * The private sessions the logged-in user may join — their own and those
     * opened by driver keys that list their email — for the landing page's
     * one-tap list. Named after the key ("Living room PC") when there is one.
     */
    listPrivateSessions: async (params: { userId: number; email: string }) => {
      const sessions = await store.getPrivateSessionsForUser(params);
      return Promise.all(
        sessions.map(async (session) => {
          const config = parseSessionConfig(session);
          const players = await store.getActivePlayersBySession(session.id);
          return {
            sessionId: session.id,
            name: session.keyName ?? config.game ?? "Private session",
            game: config.game ?? null,
            state: session.state,
            playerCount: players.length,
            maxPlayers: config.maxPlayers,
            acceptingPlayers:
              acceptsJoins(session.state, config) &&
              players.length < config.maxPlayers,
          };
        }),
      );
    },

    /** Joins a private session the logged-in user has access to. */
    joinPrivateSession: async (params: {
      userId: number;
      email: string;
      sessionId: string;
      name?: string;
    }) => {
      const [session] = await store.getPrivateSessionsForUser({
        userId: params.userId,
        email: params.email,
        sessionId: params.sessionId,
      });
      if (!session) throw notFound("Session not found");
      return joinPlayer(session, params.name);
    },

    /** The user's web-hosted session (the setup-code slot), if any. */
    getMySession: async (ownerId: number) => {
      const session = await store.getActiveHostedSessionByOwner(ownerId);
      return session ? toMySession(session, new Map()) : null;
    },

    /**
     * Every active session the user owns: the web-hosted one first, then one
     * per driver key that has a session open, named after the key.
     */
    listMySessions: async (ownerId: number) => {
      const [sessions, keys] = await Promise.all([
        store.getActiveSessionsByOwner(ownerId),
        store.getDriverKeysByUser(ownerId),
      ]);
      const keyNames = new Map<number, string>(keys.map((key) => [key.id, key.name]));
      return sessions.map((session) => toMySession(session, keyNames));
    },

    /**
     * The host escape hatch (abandoning a session the driver never claimed,
     * or killing a stuck one). Regular game shutdown is the driver's end
     * command. Without a sessionId it ends the web-hosted session.
     */
    endMySession: async (params: { ownerId: number; sessionId?: string }) => {
      const session = await findOwnedSession(params.ownerId, params.sessionId);
      if (!session) throw notFound("No active session");
      await store.endSession(session.id);
      runtimes.notifySessionEnded(session.id, "host_ended");
    },

    /**
     * The host's kick: same removal as the driver's `kick` message, for the
     * host panel (the host sees the player list but has no driver socket).
     */
    kickPlayer: async (params: {
      ownerId: number;
      playerId: string;
      /** Which of the host's sessions; the web-hosted one when omitted. */
      sessionId?: string;
    }) => {
      const session = await findOwnedSession(params.ownerId, params.sessionId);
      if (!session) throw notFound("No active session");
      const removed = await runtimes.removePlayer(
        runtimes.getRuntime(session),
        params.playerId,
      );
      if (!removed) throw notFound("Player not found");
    },

    /** Everything the join screen needs; never exposes tokens. Null for an unknown code. */
    getJoinInfo: async (joinCode: string): Promise<KapulaJoinInfo | null> => {
      const session = await findPublicSessionByJoinCode(joinCode);
      if (!session) return null;
      const config = parseSessionConfig(session);
      const players = await store.getActivePlayersBySession(session.id);
      const takenColors = new Set(players.map((p) => p.color));
      const takenNames = new Set(players.map((p) => p.name.toLowerCase()));
      const state = kapulaSessionStateSchema.parse(session.state);
      return {
        state,
        game: config.game ?? null,
        maxPlayers: config.maxPlayers,
        playerCount: players.length,
        /**
         * Whether this session takes a new player right now — the lobby, or
         * a running game the driver opened with `allowLateJoin`. The join
         * screen reads this instead of comparing the state itself.
         */
        acceptingPlayers: acceptsJoins(state, config),
        availableColors: getSessionColors(config).filter(
          (color) => !takenColors.has(color),
        ),
        schemas: config.schemas.map((schema) => ({
          id: schema.id,
          name: schema.name,
        })),
        /** Driver-predefined slots to pick from; null in a free-join session. */
        roster:
          config.roster?.map((entry) => ({
            name: entry.name,
            color: entry.color,
            taken: takenNames.has(entry.name.toLowerCase()),
          })) ?? null,
      };
    },

    /**
     * Whether a stored player credential still leads somewhere. The landing
     * page verifies its "you are in a game" card with this so a player never
     * sees one for a session that ended while they were away.
     */
    getPlayerStatus: async (token: string): Promise<KapulaPlayerStatus | null> => {
      const player = await store.getActivePlayerByToken(token);
      if (!player) return null;
      const session = await store.getActiveSessionById(player.sessionId);
      if (!session) return null;
      const config = parseSessionConfig(session);
      return {
        sessionId: session.id,
        state: session.state,
        game: config.game ?? null,
        name: player.name,
        color: player.color,
      };
    },

    /**
     * Joining takes the code; the server assigns a free "Player N" name and
     * the first free color, which the player customizes in the lobby
     * (update_profile over the WebSocket). In a roster session `name` picks
     * the predefined slot instead (required there; the slot fixes name and
     * color).
     */
    joinByCode: async (params: { joinCode: string; name?: string }) => {
      const session = await findPublicSessionByJoinCode(params.joinCode);
      if (!session) throw notFound("Session not found");
      return joinPlayer(session, params.name);
    },
  };
};

export type KapulaService = ReturnType<typeof createKapulaService>;
