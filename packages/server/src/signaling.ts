import type http from "http";
import type https from "https";
import type { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import {
  gamepadDriverClientMessageSchema,
  gamepadPlayerClientMessageSchema,
  isSelectableSchemaId,
} from "@kapula/protocol";
import type { GamepadContext } from "./context.js";
import {
  canSelectSchema,
  canSendInput,
  canSetReady,
  canUpdateProfile,
  countsAsActivity,
  DRIVER_TRANSITIONS,
  getProfileError,
  getStartError,
} from "./logic.js";
import {
  applyStateChange,
  broadcast,
  LEFT_CLOSE,
  parseSessionConfig,
  sendTo,
  sendToDriver,
  toPlayerInfo,
  type SessionRuntime,
  type SessionRuntimes,
} from "./runtime.js";
import { isStoreConflict, type GamepadPlayerRecord, type GamepadSessionRecord } from "./store.js";

/** Oversized frames are dropped without parsing. */
const MAX_MESSAGE_BYTES = 8192;

// Hard cap enforced by ws itself: frames above this close the connection
// (close code 1009) instead of being buffered whole — the MAX_MESSAGE_BYTES
// guard only runs after ws has assembled the full message in memory.
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Input frames above this per-second rate are dropped; a client far beyond it
// is closed as misbehaving.
const INPUT_RATE_LIMIT = 120;
const INPUT_RATE_KILL = 600;

const parseJson = (data: unknown): unknown => {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
};

/** Closes a previous socket for the same identity without tearing down the
 * runtime slot the replacement now occupies. */
const replaceSocket = (previous: WebSocket | null | undefined) => {
  if (previous && previous.readyState === WebSocket.OPEN) {
    previous.close(4010, "Replaced by a new connection");
  }
};

/**
 * The WebSocket side of the gamepad server: one socket per role (driver,
 * player, host) on `${basePath}/ws`. Returns the function that attaches the
 * upgrade handler to an HTTP(S) server.
 */
export const createSignaling = (
  ctx: GamepadContext,
  runtimes: SessionRuntimes,
) => {
  const { store, auth, logger, config } = ctx;
  const wsPath = `${config.basePath}/ws`;

  /** Moves players onto a schema and tells everyone, one event per player. */
  const setPlayersSchema = async (
    runtime: SessionRuntime,
    players: GamepadPlayerRecord[],
    schemaId: string,
  ): Promise<void> => {
    for (const player of players) {
      const updated = await store.updatePlayerSchema({
        playerId: player.id,
        schemaId,
      });
      if (updated) {
        broadcast(runtime, {
          type: "player_updated",
          player: toPlayerInfo(runtime, updated),
        });
      }
    }
  };

  const runDriverTransition = async (
    runtime: SessionRuntime,
    ws: WebSocket,
    command: keyof typeof DRIVER_TRANSITIONS,
  ): Promise<void> => {
    const transition = DRIVER_TRANSITIONS[command];
    if (!transition.from.includes(runtime.state)) {
      sendTo(ws, {
        type: "error",
        code: "invalid_state",
        message: `Cannot ${command} from state "${runtime.state}"`,
      });
      return;
    }

    const session = await store.getActiveSessionById(runtime.sessionId);
    if (!session) {
      ws.close(4004, "Session not found");
      return;
    }

    if (command === "start") {
      const players = await store.getActivePlayersBySession(runtime.sessionId);
      const startError = getStartError({
        state: runtime.state,
        config: parseSessionConfig(session),
        players: players.map((player) => toPlayerInfo(runtime, player)),
      });
      if (startError) {
        sendTo(ws, { type: "error", code: "cannot_start", message: startError });
        return;
      }
    }

    if (command === "end") {
      await store.endSession(runtime.sessionId);
      runtimes.notifySessionEnded(runtime.sessionId, "driver_command");
      return;
    }

    // Back to the lobby: the previous round's ready flags say nothing about
    // this one, so clear them before announcing the state — a phone that
    // re-renders on state_changed must not show a stale "ready".
    const unreadied =
      command === "lobby"
        ? await store.clearReadyBySession(runtime.sessionId)
        : [];

    await store.updateSessionState({
      sessionId: runtime.sessionId,
      state: transition.to,
    });
    applyStateChange(runtime, transition.to, "driver_command");
    for (const player of unreadied) {
      broadcast(runtime, {
        type: "player_updated",
        player: toPlayerInfo(runtime, player),
      });
    }
  };

  const handleDriverConnection = async (
    ws: WebSocket,
    session: GamepadSessionRecord,
  ) => {
    const runtime = runtimes.getRuntime(session);
    replaceSocket(runtime.driver);
    runtime.driver = ws;
    runtimes.disarmDriverLostTimer(runtime);
    runtimes.touchActivity(runtime);
    await store.markDriverConnected(runtime.sessionId);

    sendTo(ws, { type: "snapshot", snapshot: await runtimes.buildSnapshot(session) });
    broadcast(runtime, { type: "driver_connected" });

    ws.on("message", async (data) => {
      if (Buffer.byteLength(String(data)) > MAX_MESSAGE_BYTES) return;
      const parsed = gamepadDriverClientMessageSchema.safeParse(parseJson(data));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (countsAsActivity(msg.type)) runtimes.touchActivity(runtime);

      try {
        switch (msg.type) {
          case "ping":
            sendTo(ws, { type: "pong" });
            return;
          case "start":
          case "pause":
          case "resume":
          case "end":
          case "lobby":
            await runDriverTransition(runtime, ws, msg.type);
            return;
          case "message": {
            if (msg.playerId !== undefined) {
              const target = runtime.players.get(msg.playerId);
              if (target) {
                sendTo(target, { type: "message", payload: msg.payload });
              }
              return;
            }
            for (const playerWs of runtime.players.values()) {
              sendTo(playerWs, { type: "message", payload: msg.payload });
            }
            return;
          }
          case "kick": {
            const removed = await runtimes.removePlayer(runtime, msg.playerId);
            if (!removed) {
              sendTo(ws, {
                type: "error",
                code: "unknown_player",
                message: `Unknown player "${msg.playerId}"`,
              });
            }
            return;
          }
          case "set_schema": {
            // Same state rule as the player's own select_schema: allowed while
            // the session is live, in the lobby or mid-game.
            if (!canSelectSchema(runtime.state)) {
              sendTo(ws, {
                type: "error",
                code: "invalid_state",
                message: "This session is not running",
              });
              return;
            }
            const config = parseSessionConfig(session);
            if (!isSelectableSchemaId(config, msg.schemaId)) {
              sendTo(ws, {
                type: "error",
                code: "unknown_schema",
                message: `Unknown schema "${msg.schemaId}"`,
              });
              return;
            }
            // Every active player, not just the connected ones: a player who is
            // reconnecting must come back on the schema the game expects.
            const players = await store.getActivePlayersBySession(runtime.sessionId);
            if (msg.playerId === undefined) {
              // Addressed to everyone: an empty lobby is a no-op, not an error.
              await setPlayersSchema(runtime, players, msg.schemaId);
              return;
            }
            const target = players.find((p) => p.id === msg.playerId);
            if (!target) {
              sendTo(ws, {
                type: "error",
                code: "unknown_player",
                message: `Unknown player "${msg.playerId}"`,
              });
              return;
            }
            await setPlayersSchema(runtime, [target], msg.schemaId);
            return;
          }
        }
      } catch (e) {
        logger.error("[gamepad] driver message failed", e);
      }
    });

    ws.on("close", async () => {
      if (runtime.driver !== ws) return;
      runtime.driver = null;
      if (runtime.state === "ended") return;
      broadcast(runtime, { type: "driver_disconnected" });
      // The session is not kept alive for a missing driver: if it does not
      // come back within the driver-lost timeout the session ends for
      // everyone (the stored timestamp lets the cleanup job finish the job
      // after a restart).
      runtimes.armDriverLostTimer(runtime);
      try {
        await store.markDriverDisconnected(runtime.sessionId);
        // Losing the game mid-play pauses input instead of dropping it on the
        // floor; the driver resumes explicitly after reconnecting.
        if (runtime.state === "in_progress") {
          await store.updateSessionState({
            sessionId: runtime.sessionId,
            state: "paused",
          });
          applyStateChange(runtime, "paused", "driver_disconnected");
        }
      } catch (e) {
        logger.error("[gamepad] driver disconnect bookkeeping failed", e);
      }
    });
  };

  const handlePlayerConnection = async (
    ws: WebSocket,
    session: GamepadSessionRecord,
    playerToken: string,
  ) => {
    const player = await store.getActivePlayerByToken(playerToken);
    if (!player || player.sessionId !== session.id) {
      ws.close(4004, "Player not found");
      return;
    }

    const runtime = runtimes.getRuntime(session);
    const playerId = player.id;
    const config = parseSessionConfig(session);
    replaceSocket(runtime.players.get(playerId));
    runtime.players.set(playerId, ws);
    runtimes.touchActivity(runtime);

    sendTo(ws, {
      type: "snapshot",
      snapshot: await runtimes.buildSnapshot(session),
      playerId,
    });
    broadcast(runtime, { type: "player_connected", playerId });

    // Input frames and motion batches share one fixed rate window: past the
    // limit messages are dropped, past the kill level the socket goes.
    const inputWindow = { start: Date.now(), count: 0 };
    const admitInput = (): boolean => {
      const now = Date.now();
      if (now - inputWindow.start >= 1000) {
        inputWindow.start = now;
        inputWindow.count = 0;
      }
      inputWindow.count += 1;
      if (inputWindow.count > INPUT_RATE_KILL) {
        ws.close(4008, "Input rate limit exceeded");
        return false;
      }
      return inputWindow.count <= INPUT_RATE_LIMIT;
    };
    ws.on("message", async (data) => {
      if (Buffer.byteLength(String(data)) > MAX_MESSAGE_BYTES) return;
      const parsed = gamepadPlayerClientMessageSchema.safeParse(parseJson(data));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (countsAsActivity(msg.type)) runtimes.touchActivity(runtime);

      try {
        switch (msg.type) {
          case "ping":
            sendTo(ws, { type: "pong" });
            return;
          case "input": {
            if (!canSendInput(runtime.state)) return;
            if (!admitInput()) return;
            // seq is the phone's and relays untouched; the phone keeps it
            // increasing across reconnects and schema switches (seq-counter.ts).
            // A frame that does not advance it is stale — the driver would drop
            // it anyway — so it is dropped here, silently.
            if (msg.seq <= (runtime.lastInputSeq.get(playerId) ?? -1)) return;
            runtime.lastInputSeq.set(playerId, msg.seq);
            sendToDriver(runtime, {
              type: "input",
              playerId,
              seq: msg.seq,
              controls: msg.controls,
            });
            return;
          }
          case "motion": {
            // A stream, not state: no seq, nothing latest-wins — every batch
            // goes through in order. Shares the input rate window: batches of
            // sensor samples arrive at ~20/s, well inside it alongside input.
            if (!canSendInput(runtime.state)) return;
            if (!admitInput()) return;
            sendToDriver(runtime, { type: "motion", playerId, samples: msg.samples });
            return;
          }
          case "text": {
            // An event like motion: relayed in order, never deduplicated.
            if (!canSendInput(runtime.state)) return;
            if (!admitInput()) return;
            sendToDriver(runtime, {
              type: "text",
              playerId,
              controlId: msg.controlId,
              text: msg.text,
            });
            return;
          }
          case "set_ready": {
            if (!canSetReady(runtime.state)) {
              sendTo(ws, {
                type: "error",
                code: "invalid_state",
                message: "Ready can only be changed in the lobby",
              });
              return;
            }
            const updated = await store.updatePlayerReady({
              playerId,
              ready: msg.ready,
            });
            if (updated) {
              broadcast(runtime, {
                type: "player_updated",
                player: toPlayerInfo(runtime, updated),
              });
            }
            return;
          }
          case "update_profile": {
            if (!canUpdateProfile(runtime.state, config)) {
              sendTo(ws, {
                type: "error",
                code: config.roster ? "profile_locked" : "invalid_state",
                message: config.roster
                  ? "The game set the names and colors for this session"
                  : "Name and color can only be changed in the lobby",
              });
              return;
            }
            const players = await store.getActivePlayersBySession(runtime.sessionId);
            const self = players.find((p) => p.id === playerId);
            if (!self) return;
            const name = msg.name ?? self.name;
            const color = msg.color ?? self.color;
            const profileError = getProfileError({
              config,
              otherPlayers: players
                .filter((p) => p.id !== playerId)
                .map((p) => ({ name: p.name, color: p.color })),
              name,
              color,
            });
            if (profileError) {
              sendTo(ws, {
                type: "error",
                code: "profile_taken",
                message: profileError,
              });
              return;
            }
            try {
              const updated = await store.updatePlayerProfile({ playerId, name, color });
              if (updated) {
                broadcast(runtime, {
                  type: "player_updated",
                  player: toPlayerInfo(runtime, updated),
                });
              }
            } catch (e) {
              // The store's uniqueness rules are the backstop for update races.
              if (isStoreConflict(e)) {
                sendTo(ws, {
                  type: "error",
                  code: "profile_taken",
                  message: "That name or color was just taken",
                });
                return;
              }
              throw e;
            }
            return;
          }
          case "select_schema": {
            if (!canSelectSchema(runtime.state)) {
              sendTo(ws, {
                type: "error",
                code: "invalid_state",
                message: "This session is not running",
              });
              return;
            }
            if (!isSelectableSchemaId(config, msg.schemaId)) {
              sendTo(ws, {
                type: "error",
                code: "unknown_schema",
                message: `Unknown schema "${msg.schemaId}"`,
              });
              return;
            }
            const updated = await store.updatePlayerSchema({
              playerId,
              schemaId: msg.schemaId,
            });
            if (updated) {
              broadcast(runtime, {
                type: "player_updated",
                player: toPlayerInfo(runtime, updated),
              });
            }
            return;
          }
          case "leave": {
            // Deliberately allowed in any state: a paused or otherwise stuck
            // session must never trap a player. Marking the player left frees
            // the name/color slot and kills the token, so this is not a
            // reconnectable disconnect.
            //
            // Shared with the driver's kick (runtime.ts); leaving of one's own
            // accord closes with a normal 1000 rather than the kick's 4011.
            await runtimes.removePlayer(runtime, playerId, LEFT_CLOSE);
            return;
          }
        }
      } catch (e) {
        logger.error("[gamepad] player message failed", e);
      }
    });

    ws.on("close", () => {
      if (runtime.players.get(playerId) !== ws) return;
      runtime.players.delete(playerId);
      broadcast(runtime, { type: "player_disconnected", playerId });
    });
  };

  const handleHostConnection = async (
    ws: WebSocket,
    req: IncomingMessage,
    sessionIdParam: string | null,
  ) => {
    const user = await auth.getUserFromRequest(req);
    if (!user) {
      ws.close(4001, "Unauthorized");
      return;
    }
    if (!sessionIdParam) {
      ws.close(4000, "sessionId required");
      return;
    }
    // Ids are decimal strings; a store must never see anything else.
    if (!/^\d{1,18}$/.test(sessionIdParam)) {
      ws.close(4000, "sessionId invalid");
      return;
    }
    const session = await store.getActiveSessionById(sessionIdParam);
    if (!session || session.ownerId !== user.id) {
      ws.close(4004, "Session not found");
      return;
    }

    const runtime = runtimes.getRuntime(session);
    replaceSocket(runtime.host);
    runtime.host = ws;

    sendTo(ws, { type: "snapshot", snapshot: await runtimes.buildSnapshot(session) });

    ws.on("message", (data) => {
      const msg = parseJson(data) as { type?: string } | null;
      if (msg?.type === "ping") sendTo(ws, { type: "pong" });
    });

    ws.on("close", () => {
      if (runtime.host === ws) runtime.host = null;
    });
  };

  const attachWebSocket = (
    server: http.Server | https.Server,
  ): WebSocketServer => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

    // WebSocket-level liveness probe. A socket whose network died silently (a
    // phone that lost its connection, a driver's machine asleep) stays "open"
    // to the process until TCP gives up, so input would be relayed into a dead
    // driver and the driver-lost clock would never start. Every tick pings
    // each client and terminates the ones that did not answer the previous
    // one, so a silent socket is gone within two ticks. Browsers, Node's
    // built-in WebSocket and the `ws` package all answer a ping frame
    // automatically, so this needs nothing from the clients. The phone
    // additionally sends an application-level `ping` (useGamepadSocket) to
    // keep proxies from dropping an idle socket in a quiet lobby.
    const answeredLastPing = new WeakSet<WebSocket>();
    const keepalive = setInterval(() => {
      for (const client of wss.clients) {
        if (!answeredLastPing.has(client)) {
          client.terminate();
          continue;
        }
        answeredLastPing.delete(client);
        client.ping();
      }
    }, config.keepaliveIntervalMs);
    wss.on("close", () => clearInterval(keepalive));

    // Every driver socket died with the previous process: start the
    // driver-away clock on all live sessions so the cleanup job ends the ones
    // whose driver never comes back (a reconnecting driver clears it again).
    store
      .markAllDriversDisconnected()
      .then((count) => {
        if (count > 0) {
          logger.info(
            `[gamepad] ${count} session(s) waiting for their driver after restart`,
          );
        }
      })
      .catch((e) => logger.error("[gamepad] boot driver bookkeeping failed", e));

    server.on("upgrade", (request, socket, head) => {
      const host = request.headers.host ?? "localhost";
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
      } catch {
        socket.destroy();
        return;
      }
      // Other apps register their own upgrade handlers; only claim our path.
      if (pathname !== wsPath) return;

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
      // Socket-level failures (protocol violations, frames over maxPayload,
      // network resets) emit 'error'; without a listener they crash the process.
      ws.on("error", (e) => logger.debug("[gamepad] socket error", e));

      // Fresh sockets count as answered until the first ping goes out.
      answeredLastPing.add(ws);
      ws.on("pong", () => answeredLastPing.add(ws));

      const host = req.headers.host ?? "localhost";
      let searchParams: URLSearchParams;
      try {
        searchParams = new URL(req.url ?? "/", `http://${host}`).searchParams;
      } catch {
        ws.close(4000, "Bad request");
        return;
      }

      const role = searchParams.get("role");
      const token = searchParams.get("token");

      try {
        if (role === "driver") {
          if (!token) {
            ws.close(4000, "token required");
            return;
          }
          const session = await store.getActiveSessionByDriverToken(token);
          if (!session) {
            ws.close(4004, "Session not found");
            return;
          }
          await handleDriverConnection(ws, session);
          return;
        }

        if (role === "player") {
          if (!token) {
            ws.close(4000, "token required");
            return;
          }
          const player = await store.getActivePlayerByToken(token);
          if (!player) {
            ws.close(4004, "Player not found");
            return;
          }
          const session = await store.getActiveSessionById(player.sessionId);
          if (!session) {
            ws.close(4004, "Session not found");
            return;
          }
          await handlePlayerConnection(ws, session, token);
          return;
        }

        if (role === "host") {
          await handleHostConnection(ws, req, searchParams.get("sessionId"));
          return;
        }

        ws.close(4000, "Invalid role");
      } catch (e) {
        logger.error("[gamepad] connection setup failed", e);
        ws.close(4000, "Internal error");
      }
    });

    return wss;
  };

  return attachWebSocket;
};
