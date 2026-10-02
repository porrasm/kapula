import { WebSocket } from "ws";
import {
  GAMEPAD_PROTOCOL_VERSION,
  gamepadBackgroundFitSchema,
  gamepadSessionConfigSchema,
  type GamepadBackground,
  type GamepadPlayerInfo,
  type GamepadServerMessage,
  type GamepadSessionSnapshot,
  type GamepadSessionState,
  type GamepadStateChangeReason,
} from "@kapula/protocol";
import type { GamepadContext } from "./context.js";
import type {
  GamepadBackgroundMeta,
  GamepadPlayerRecord,
  GamepadSessionRecord,
} from "./store.js";

/**
 * In-memory connection state per active session. This lives in the single
 * Node process; the store holds the durable records so sessions survive a
 * restart and clients reconnect into them.
 */
export type SessionRuntime = {
  sessionId: string;
  /** Mirrors the stored state so the hot input path never reads the store. */
  state: GamepadSessionState;
  driver: WebSocket | null;
  host: WebSocket | null;
  players: Map<string, WebSocket>;
  /**
   * Highest input seq relayed to the driver, per player. The phone owns seq
   * and keeps it strictly increasing for the player's lifetime (across
   * reconnects and schema switches); frames that do not exceed this mark are
   * stale and dropped instead of relayed.
   */
  lastInputSeq: Map<string, number>;
  lastActivityTouch: number;
  /** Armed while the driver is away; fires the driver-lost end of session. */
  driverLostTimer: NodeJS.Timeout | null;
};

export const parseSessionConfig = (session: GamepadSessionRecord) =>
  // A not_initialized session has no config yet (the host connects before the
  // driver's setup call); the defaults stand in until then.
  gamepadSessionConfigSchema.parse(session.config ?? {});

const safeSend = (ws: WebSocket, msg: GamepadServerMessage) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

export const sendTo = (ws: WebSocket, msg: GamepadServerMessage) =>
  safeSend(ws, msg);

export const sendToDriver = (
  runtime: SessionRuntime,
  msg: GamepadServerMessage,
) => {
  if (runtime.driver) safeSend(runtime.driver, msg);
};

/** Sends to driver, host and every player (input never goes through here). */
export const broadcast = (
  runtime: SessionRuntime,
  msg: GamepadServerMessage,
) => {
  if (runtime.driver) safeSend(runtime.driver, msg);
  if (runtime.host) safeSend(runtime.host, msg);
  for (const ws of runtime.players.values()) {
    safeSend(ws, msg);
  }
};

export const toPlayerInfo = (
  runtime: SessionRuntime,
  player: GamepadPlayerRecord,
): GamepadPlayerInfo => ({
  playerId: player.id,
  name: player.name,
  color: player.color,
  ready: player.ready,
  connected: runtime.players.get(player.id)?.readyState === WebSocket.OPEN,
  schemaId: player.schemaId ?? "",
});

export const applyStateChange = (
  runtime: SessionRuntime,
  state: GamepadSessionState,
  reason: GamepadStateChangeReason,
) => {
  runtime.state = state;
  broadcast(runtime, { type: "state_changed", state, reason });
};

/** How a removed player's own socket is closed; see removePlayer. */
export const KICKED_CLOSE = { code: 4011, reason: "Removed from the session" };
export const LEFT_CLOSE = { code: 1000, reason: "Left session" };

/**
 * The per-process registry of session runtimes and everything that touches
 * both the sockets and the store: snapshots, the driver-lost watchdog, player
 * removal, session end. One per gamepad server instance.
 */
export const createSessionRuntimes = (ctx: GamepadContext) => {
  const { store, logger, config } = ctx;
  const runtimes = new Map<string, SessionRuntime>();

  /** Where phones fetch a posted background; served by the driver router. */
  const backgroundUrl = (key: string): string =>
    `${config.basePath}/background/${key}`;

  const toBackground = (meta: GamepadBackgroundMeta): GamepadBackground => ({
    url: backgroundUrl(meta.key),
    fit: gamepadBackgroundFitSchema.parse(meta.fit),
  });

  const endLostSession = async (sessionId: string) => {
    try {
      const ended = await store.endSession(sessionId);
      // Already ended by someone else (driver end, host end, cleanup) —
      // nothing to announce; whoever ended it did.
      if (!ended) return;
      logger.info(`[gamepad] session ${sessionId} ended: driver lost`);
      notifySessionEnded(sessionId, "driver_lost");
    } catch (e) {
      logger.error("[gamepad] ending a driver-lost session failed", e);
    }
  };

  /**
   * Starts (or restarts from `sinceMs`) the countdown that ends the session
   * if no driver connects in time. Idempotent: an already armed timer is kept
   * so repeated triggers cannot push the deadline out.
   */
  const armDriverLostTimer = (
    runtime: SessionRuntime,
    sinceMs: number = Date.now(),
  ) => {
    if (runtime.driverLostTimer) return;
    const remaining = Math.max(
      0,
      sinceMs + config.driverLostTimeoutMs - Date.now(),
    );
    runtime.driverLostTimer = setTimeout(() => {
      runtime.driverLostTimer = null;
      if (runtime.driver?.readyState === WebSocket.OPEN) return;
      void endLostSession(runtime.sessionId);
    }, remaining);
    // Never keep the process alive just for this.
    runtime.driverLostTimer.unref?.();
  };

  const disarmDriverLostTimer = (runtime: SessionRuntime) => {
    if (!runtime.driverLostTimer) return;
    clearTimeout(runtime.driverLostTimer);
    runtime.driverLostTimer = null;
  };

  /**
   * Resumes the driver-away clock from the store's own measurement of it
   * (the store compares its clock against its timestamps — see the store
   * contract). Asynchronous, so a driver that connects meanwhile simply finds
   * no timer to disarm; the fired timer re-checks the driver socket before
   * ending anything.
   */
  const armDriverLostTimerFromStore = async (runtime: SessionRuntime) => {
    try {
      const awayMs = await store.getDriverAwayMs(runtime.sessionId);
      // Driver back, or session gone, before we got here.
      if (awayMs === null || runtime.driver?.readyState === WebSocket.OPEN) return;
      armDriverLostTimer(runtime, Date.now() - awayMs);
    } catch (e) {
      logger.error("[gamepad] resuming the driver-lost clock failed", e);
    }
  };

  const getRuntime = (session: GamepadSessionRecord): SessionRuntime => {
    let runtime = runtimes.get(session.id);
    if (!runtime) {
      runtime = {
        sessionId: session.id,
        state: session.state,
        driver: null,
        host: null,
        players: new Map(),
        lastInputSeq: new Map(),
        lastActivityTouch: 0,
        driverLostTimer: null,
      };
      runtimes.set(session.id, runtime);
      // A runtime materializing for a driver-less session (first connection
      // after a server restart, typically) resumes the clock the store kept.
      if (runtime.state !== "not_initialized" && session.driverAway) {
        void armDriverLostTimerFromStore(runtime);
      }
    }
    return runtime;
  };

  const maybeRuntime = (sessionId: string): SessionRuntime | undefined =>
    runtimes.get(sessionId);

  const buildSnapshot = async (
    session: GamepadSessionRecord,
  ): Promise<GamepadSessionSnapshot> => {
    const runtime = getRuntime(session);
    const [players, background] = await Promise.all([
      store.getActivePlayersBySession(session.id),
      store.getSessionBackgroundMeta(session.id),
    ]);
    return {
      protocolVersion: GAMEPAD_PROTOCOL_VERSION,
      sessionId: session.id,
      state: runtime.state,
      config: parseSessionConfig(session),
      driverConnected: runtime.driver?.readyState === WebSocket.OPEN,
      players: players.map((player) => toPlayerInfo(runtime, player)),
      // Absent, not null, when there is none: a snapshot of a session without
      // a background is byte for byte what it was before backgrounds existed.
      ...(background ? { background: toBackground(background) } : {}),
    };
  };

  /**
   * Tells every connected phone about a new (or removed) background. Players
   * only: the driver just posted it and has the answer, the host shows none.
   */
  const notifyBackgroundChanged = (
    sessionId: string,
    background: GamepadBackground | null,
  ) => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    for (const ws of runtime.players.values()) {
      safeSend(ws, { type: "background_changed", background });
    }
  };

  /** Debounced last-activity write; every WS message calls this. */
  const touchActivity = (runtime: SessionRuntime) => {
    const now = Date.now();
    if (now - runtime.lastActivityTouch < 10_000) return;
    runtime.lastActivityTouch = now;
    store
      .touchSessionActivity(runtime.sessionId)
      .catch((e) => logger.error("[gamepad] touchSessionActivity failed", e));
  };

  /**
   * Removes a player for good, freeing the name/color slot and killing the
   * token: the shared path behind the player's own `leave`, the driver's
   * `kick` and the host's kick — only the close code differs.
   *
   * The runtime entry goes first, before the store await: a leaving phone
   * closes its socket right after sending `leave`, and a close landing
   * mid-await would otherwise find the player still registered and announce
   * a `player_disconnected` for an exit already in progress.
   *
   * Returns false when there was no such active player (already gone).
   */
  const removePlayer = async (
    runtime: SessionRuntime,
    playerId: string,
    close: { code: number; reason: string } = KICKED_CLOSE,
  ): Promise<boolean> => {
    const ws = runtime.players.get(playerId);
    runtime.players.delete(playerId);
    runtime.lastInputSeq.delete(playerId);
    const removed = await store.markPlayerLeft(playerId);
    if (removed) broadcast(runtime, { type: "player_left", playerId });
    ws?.close(close.code, close.reason);
    return removed !== null;
  };

  /**
   * Terminal cleanup used by the driver's end command, the host's end, the
   * driver-lost watchdog and the cleanup job. The stored session must already
   * be ended by the caller.
   */
  const notifySessionEnded = (
    sessionId: string,
    reason: GamepadStateChangeReason,
  ) => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    disarmDriverLostTimer(runtime);
    applyStateChange(runtime, "ended", reason);
    runtime.driver?.close(4005, "Session ended");
    runtime.host?.close(4005, "Session ended");
    for (const ws of runtime.players.values()) {
      ws.close(4005, "Session ended");
    }
    runtimes.delete(sessionId);
  };

  /** Lets the join path announce a player who joined over HTTP. */
  const notifyPlayerJoined = (
    session: GamepadSessionRecord,
    player: GamepadPlayerRecord,
  ) => {
    const runtime = getRuntime(session);
    broadcast(runtime, {
      type: "player_joined",
      player: toPlayerInfo(runtime, player),
    });
  };

  /** Lets the driver setup endpoint push the new state + snapshot to the host. */
  const notifySessionSetup = async (session: GamepadSessionRecord) => {
    const runtime = getRuntime(session);
    runtime.state = "waiting_for_players";
    // The driver has the token now but no socket yet: a driver that never
    // connects is lost like any other.
    armDriverLostTimer(runtime);
    if (runtime.host) {
      safeSend(runtime.host, {
        type: "snapshot",
        snapshot: await buildSnapshot(session),
      });
    }
  };

  return {
    getRuntime,
    maybeRuntime,
    armDriverLostTimer,
    disarmDriverLostTimer,
    backgroundUrl,
    toBackground,
    buildSnapshot,
    notifyBackgroundChanged,
    touchActivity,
    removePlayer,
    notifySessionEnded,
    notifyPlayerJoined,
    notifySessionSetup,
  };
};

export type SessionRuntimes = ReturnType<typeof createSessionRuntimes>;
