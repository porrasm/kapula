import express from "express";
import {
  GAMEPAD_DEFAULT_CONFIG,
  type GamepadAuth,
  type GamepadContext,
  type GamepadLogger,
  type GamepadServerConfig,
} from "./context.js";
import { createDriverRouter } from "./driver-api.js";
import { createHostRouter } from "./host-api.js";
import { createPlayerRouter } from "./player-api.js";
import { createSessionRuntimes } from "./runtime.js";
import { createGamepadService } from "./service.js";
import { createSignaling } from "./signaling.js";
import type { GamepadStore } from "./store.js";

export type GamepadServerDeps = {
  store: GamepadStore;
  auth: GamepadAuth;
  logger: GamepadLogger;
  /** Overrides of {@link GAMEPAD_DEFAULT_CONFIG}; undefined values keep the default. */
  config?: Partial<GamepadServerConfig>;
};

const withDefaults = (
  overrides: Partial<GamepadServerConfig> | undefined,
): GamepadServerConfig => {
  const config = { ...GAMEPAD_DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) (config as Record<string, unknown>)[key] = value;
  }
  return config;
};

/**
 * One gamepad server: everything the protocol needs on the server side,
 * built over the host's store, auth and logger. The host mounts
 * `httpRouter` (the driver, player and host JSON APIs) at `config.basePath`
 * outside its own user auth — the host API authenticates through
 * `deps.auth` — calls `attachWebSocket` on its HTTP(S) server and runs
 * `runCleanup` about once a minute. A host with its own RPC layer can skip
 * the host API and wrap `service` directly.
 */
export const createGamepadServer = (deps: GamepadServerDeps) => {
  const ctx: GamepadContext = {
    store: deps.store,
    auth: deps.auth,
    logger: deps.logger,
    config: withDefaults(deps.config),
  };
  const runtimes = createSessionRuntimes(ctx);
  const attachWebSocket = createSignaling(ctx, runtimes);
  const service = createGamepadService(ctx, runtimes);
  const httpRouter = express
    .Router()
    .use(createDriverRouter(ctx, runtimes))
    .use(createPlayerRouter(ctx, service))
    .use("/host", createHostRouter(ctx, service));

  /**
   * The durable backstop for the driver-lost watchdog (whose in-memory
   * timers die with the process) and the idle rules; run it often enough
   * that a session never lingers long past the timeout — every minute.
   */
  const runCleanup = async () => {
    const ended = await ctx.store.endInactiveSessions({
      driverLostMs: ctx.config.driverLostTimeoutMs,
    });
    for (const { sessionId, driverLost } of ended) {
      runtimes.notifySessionEnded(sessionId, driverLost ? "driver_lost" : "inactivity");
    }
    // However a session ended (driver, host, this job), its image is dead
    // weight from then on — the URL already stopped serving it.
    await ctx.store.deleteEndedSessionBackgrounds();
  };

  return { config: ctx.config, runtimes, httpRouter, attachWebSocket, service, runCleanup };
};

export type GamepadServer = ReturnType<typeof createGamepadServer>;
