import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { createGamepadServer, createMemoryGamepadStore } from "@kapula/server";
import { createHostAuth } from "./auth.js";
import { readConfig } from "./config.js";

/**
 * The reference Kapula host: the server core over an in-memory store, the
 * phone web app, and a minimal host page to create sessions — enough to
 * develop against, to run the test suites on, and to self-host for a
 * single owner. Sessions live in memory: a restart ends them all.
 */

// apps/host, whether this file runs from src/ (tsx) or dist/server/ (built).
const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.resolve(FILE_DIR, path.basename(path.dirname(FILE_DIR)) === "dist" ? "../.." : "..");
const API_BASE = "/api/gamepad";

const main = async () => {
  const config = readConfig(process.env);
  const { auth, router: authRouter } = createHostAuth(config);
  const gamepad = createGamepadServer({
    store: createMemoryGamepadStore(),
    auth,
    logger: console,
    config: {
      basePath: API_BASE,
      // The phone app is served at the root: join links are /join/CODE.
      playerAppPath: "",
      driverLostTimeoutMs: config.driverLostTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      allowRateLimitKeyHeader: !config.production,
    },
  });

  const app = express();
  app.set("trust proxy", true);
  // Browser drivers (a WebGL game on its own origin) call the driver API
  // cross-origin; reflect any origin, the endpoints authenticate by token.
  app.use("/api", cors({ origin: true }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use(gamepad.config.basePath, gamepad.httpRouter);
  setInterval(() => {
    gamepad.runCleanup().catch((e) => console.error("[kapula] cleanup failed", e));
  }, 60_000).unref();

  if (config.production) {
    const webDir = path.join(HOST_DIR, "dist", "web");
    app.use(express.static(webDir, { index: false }));
    app.get("*", (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  } else {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      root: HOST_DIR,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = http.createServer(app);
  gamepad.attachWebSocket(server);
  server.listen(config.port, () => {
    console.log(
      `[kapula] host listening on http://localhost:${config.port}` +
        (config.devAuth ? " (dev auth on)" : "") +
        (config.ownerToken ? " (owner login on)" : ""),
    );
  });
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
