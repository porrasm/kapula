import express from "express";
import {
  GAMEPAD_BACKGROUND_MAX_BYTES,
  GAMEPAD_PROTOCOL_VERSION,
  gamepadBackgroundFitSchema,
  gamepadDriverCreateRequestSchema,
  gamepadDriverSetupRequestSchema,
  type GamepadDriverSetupResponse,
  type GamepadSessionConfig,
} from "@kapula/protocol";
import type { GamepadContext } from "./context.js";
import {
  createRateLimiter,
  generateGamepadCode,
  generateGamepadToken,
  hashDriverKey,
  sniffImageType,
} from "./logic.js";
import type { SessionRuntimes } from "./runtime.js";
import { isStoreConflict, type GamepadSessionRecord } from "./store.js";

/**
 * Plain JSON API for external drivers (games, desktop clients) — they should
 * not need a tRPC client. Mount it outside any user-session auth: drivers are
 * authenticated by the setup code / driver token, not by a user session.
 * Documented in GAMEPAD.md.
 */

/**
 * The limiter key is the caller IP. A caller may scope itself with this
 * header instead when the config allows it (test suites sharing localhost
 * would otherwise throttle each other). Production must not allow it — a
 * spoofable header must never bypass the brute-force guard.
 */
const RATE_LIMIT_KEY_HEADER = "x-gamepad-ratelimit-key";

/** `Authorization: Bearer gpk_…` — the driver key on /driver/create. */
const getBearerKey = (req: express.Request): string | null => {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const [scheme, value] = auth.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
};

/** Shared by both entry points; absent means "whatever this server serves". */
const unsupportedVersion = (protocolVersion: number | undefined): boolean =>
  protocolVersion !== undefined && protocolVersion !== GAMEPAD_PROTOCOL_VERSION;

export const createDriverRouter = (
  ctx: GamepadContext,
  runtimes: SessionRuntimes,
): express.Router => {
  const { store, logger, config } = ctx;

  // Setup codes are short and human-typeable, so slow down brute force. The
  // window logic lives in logic.ts (createRateLimiter) under unit test.
  const setupRateLimiter = createRateLimiter({
    windowMs: 60_000,
    maxAttempts: 10,
  });

  const rateLimitKey = (req: express.Request): string => {
    if (config.allowRateLimitKeyHeader) {
      const override = req.get(RATE_LIMIT_KEY_HEADER);
      if (override) return override;
    }
    return req.ip ?? "unknown";
  };

  /**
   * The origin to hand out in absolute URLs: the configured one when there is
   * one (the bare domain in production — the one that works for everyone),
   * else the request host. `secure` is the scheme as a boolean, so the caller
   * can pick http/ws.
   */
  const publicOrigin = (
    req: express.Request,
  ): { host: string; secure: boolean } =>
    config.publicOrigin ?? { host: req.get("host") ?? "localhost", secure: req.secure };

  /**
   * Where players go to join. Drivers typically render this as a QR code. A
   * private session cannot be joined by code, so its link is the landing
   * page, where the users allowed in find it in their private-session list.
   */
  const buildJoinUrl = (
    req: express.Request,
    joinCode: string,
    isPrivate: boolean,
  ): string => {
    const { host, secure } = publicOrigin(req);
    const origin = `${secure ? "https" : "http"}://${host}${config.playerAppPath}`;
    return isPrivate ? `${origin}/` : `${origin}/join/${joinCode}`;
  };

  /**
   * The driver's WebSocket, absolute. `wsPath` is relative, which makes every
   * driver rebuild the URL from its own notion of the base — an embedded game
   * (the tank game gets its base through a query parameter) has no reliable
   * one.
   */
  const buildWsUrl = (req: express.Request, wsPath: string): string => {
    const { host, secure } = publicOrigin(req);
    return `${secure ? "wss" : "ws"}://${host}${wsPath}`;
  };

  /**
   * The half of session setup that both entry points share: give the session
   * a driver token and a join code, open it for players and describe it back
   * to the driver. `/driver/setup` gets here through a host-issued setup
   * code, `/driver/create` through the caller's own driver key.
   *
   * Returns null when the session was claimed by someone else in between.
   */
  const setUpSession = async (
    session: GamepadSessionRecord,
    sessionConfig: GamepadSessionConfig,
    req: express.Request,
  ): Promise<GamepadDriverSetupResponse | null> => {
    const driverToken = generateGamepadToken();
    let updated: GamepadSessionRecord | null = null;
    // Join codes are unique among active sessions; retry on collisions.
    for (let i = 0; i < 5 && !updated; i++) {
      try {
        updated = await store.setupSession({
          sessionId: session.id,
          joinCode: generateGamepadCode(),
          driverToken,
          config: sessionConfig,
        });
      } catch (e) {
        if (!isStoreConflict(e) || i === 4) throw e;
      }
    }
    if (!updated || !updated.joinCode) return null;

    // The owner is deliberately NOT auto-joined: hosting and playing are
    // separate — a host who wants to play joins with the join code like
    // anyone else.
    await runtimes.notifySessionSetup(updated);

    const wsPath = `${config.basePath}/ws?role=driver&token=${driverToken}`;
    return {
      protocolVersion: GAMEPAD_PROTOCOL_VERSION,
      sessionId: updated.id,
      joinCode: updated.joinCode,
      joinUrl: buildJoinUrl(req, updated.joinCode, sessionConfig.private),
      driverToken,
      wsPath,
      wsUrl: buildWsUrl(req, wsPath),
      // undefined is dropped by res.json, so an unset field stays absent.
      metadata: updated.metadata ?? undefined,
    };
  };

  const router = express.Router();

  router.post("/driver/setup", async (req, res) => {
    try {
      if (setupRateLimiter.isLimited(rateLimitKey(req))) {
        return res
          .status(429)
          .json({ success: false, error: "Too many attempts, slow down" });
      }

      const parsed = gamepadDriverSetupRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Invalid setup request",
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`,
          ),
        });
      }
      const { setupCode, config: sessionConfig, protocolVersion } = parsed.data;
      // Asking for a version this server does not serve is a hard stop:
      // better a refused setup than a driver that misreads the frames it
      // gets. Checked before the code lookup so a rejected attempt does not
      // burn the code.
      if (unsupportedVersion(protocolVersion)) {
        return res.status(400).json({
          success: false,
          error: "Unsupported protocol version",
          supported: [GAMEPAD_PROTOCOL_VERSION],
        });
      }

      const session = await store.getActiveSessionBySetupCode(setupCode);
      if (!session) {
        return res
          .status(404)
          .json({ success: false, error: "Unknown or already used setup code" });
      }

      const response = await setUpSession(session, sessionConfig, req);
      if (!response) {
        // Lost a race: another setup call consumed the code first.
        return res
          .status(409)
          .json({ success: false, error: "Session was already set up" });
      }
      return res.json({ success: true, ...response });
    } catch (e) {
      logger.error("[gamepad] driver setup failed", e);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error" });
    }
  });

  /**
   * The standalone-driver entry point: no host, no setup code, no browser —
   * the driver authenticates with its owner's key and gets a session back,
   * so connecting controllers is "click start, show the QR code".
   */
  router.post("/driver/create", async (req, res) => {
    try {
      if (setupRateLimiter.isLimited(rateLimitKey(req))) {
        return res
          .status(429)
          .json({ success: false, error: "Too many attempts, slow down" });
      }

      const key = getBearerKey(req);
      if (!key) {
        return res
          .status(401)
          .json({ success: false, error: "Driver key required" });
      }

      const parsed = gamepadDriverCreateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Invalid create request",
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`,
          ),
        });
      }
      const { config: sessionConfig, protocolVersion, replaceExisting } = parsed.data;
      if (unsupportedVersion(protocolVersion)) {
        return res.status(400).json({
          success: false,
          error: "Unsupported protocol version",
          supported: [GAMEPAD_PROTOCOL_VERSION],
        });
      }

      // Only the hash is ever compared, and it is looked up by the store —
      // the plain key never reaches a byte-by-byte comparison, so there is
      // no timing signal to read. A revoked key simply does not match.
      const keyRecord = await store.getLiveDriverKeyByHash(hashDriverKey(key));
      if (!keyRecord) {
        return res
          .status(401)
          .json({ success: false, error: "Unknown or revoked driver key" });
      }

      // One active session per driver key — each key is its own slot, apart
      // from the owner's web-hosted session and from their other keys, so
      // `replaceExisting` only ever replaces what this key opened.
      const existing = await store.getActiveSessionByDriverKey(keyRecord.id);
      if (existing) {
        if (!replaceExisting) {
          return res.status(409).json({
            success: false,
            error: "This driver key already has an active session",
          });
        }
        await store.endSession(existing.id);
        runtimes.notifySessionEnded(existing.id, "host_ended");
      }

      // The session is born and claimed in one call, so its setup code exists
      // only for the moment between (setUpSession consumes it) — nobody ever
      // sees or types it.
      let session: GamepadSessionRecord | null = null;
      for (let i = 0; i < 5 && !session; i++) {
        try {
          session = await store.createSession({
            ownerId: keyRecord.userId,
            setupCode: generateGamepadCode(),
            metadata: null,
            driverKeyId: keyRecord.id,
          });
        } catch (e) {
          if (!isStoreConflict(e) || i === 4) throw e;
        }
      }
      if (!session) {
        return res
          .status(409)
          .json({ success: false, error: "Could not create a session" });
      }

      const response = await setUpSession(session, sessionConfig, req);
      if (!response) {
        return res
          .status(409)
          .json({ success: false, error: "Session was already set up" });
      }
      await store.touchDriverKeyUsed(keyRecord.id);
      return res.json({ success: true, ...response });
    } catch (e) {
      logger.error("[gamepad] driver create failed", e);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error" });
    }
  });

  // --- Background image ---

  // An upload is a few megabytes through the store and out to every phone:
  // generous for a game changing scenes, a wall against a runaway loop.
  const backgroundRateLimiter = createRateLimiter({
    windowMs: 60_000,
    maxAttempts: 30,
  });

  /**
   * The driver's session from `Authorization: Bearer <driverToken>`, or an
   * error response already sent.
   */
  const requireDriverSession = async (
    req: express.Request,
    res: express.Response,
  ): Promise<GamepadSessionRecord | null> => {
    const token = getBearerKey(req);
    if (!token) {
      res.status(401).json({ success: false, error: "Driver token required" });
      return null;
    }
    const session = await store.getActiveSessionByDriverToken(token);
    if (!session) {
      res
        .status(401)
        .json({ success: false, error: "Unknown driver token or session ended" });
      return null;
    }
    if (backgroundRateLimiter.isLimited(session.id)) {
      res
        .status(429)
        .json({ success: false, error: "Too many uploads, slow down" });
      return null;
    }
    return session;
  };

  /**
   * `POST {basePath}/driver/background?fit=cover|contain|fill` — the body is
   * the image itself (PNG, JPEG, GIF or WebP, at most
   * GAMEPAD_BACKGROUND_MAX_BYTES), whatever Content-Type it claims. Replaces
   * the session's previous image; every phone switches to it at once.
   */
  router.post(
    "/driver/background",
    // Authenticate before reading a byte of the body: an anonymous caller
    // must not get to make the server buffer megabytes.
    async (req, res, next) => {
      try {
        const session = await requireDriverSession(req, res);
        if (!session) return;
        res.locals.session = session;
        next();
      } catch (e) {
        next(e);
      }
    },
    express.raw({ type: () => true, limit: GAMEPAD_BACKGROUND_MAX_BYTES }),
    async (req, res) => {
      try {
        const session = res.locals.session as GamepadSessionRecord;

        const fit = gamepadBackgroundFitSchema.safeParse(req.query.fit ?? "cover");
        if (!fit.success) {
          return res.status(400).json({
            success: false,
            error: `fit must be one of ${gamepadBackgroundFitSchema.options.join(", ")}`,
          });
        }
        const body: unknown = req.body;
        const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        const contentType = sniffImageType(bytes);
        if (!contentType) {
          return res.status(415).json({
            success: false,
            error: "The body must be a PNG, JPEG, GIF or WebP image",
          });
        }

        const meta = await store.upsertSessionBackground({
          sessionId: session.id,
          // A fresh key per upload: the URL names one version of the image,
          // so phones cache it forever and a new upload is a new URL.
          key: generateGamepadToken(),
          contentType,
          fit: fit.data,
          data: bytes.toString("base64"),
        });
        const background = runtimes.toBackground(meta);
        runtimes.notifyBackgroundChanged(session.id, background);
        return res.json({ success: true, background });
      } catch (e) {
        logger.error("[gamepad] background upload failed", e);
        return res
          .status(500)
          .json({ success: false, error: "Internal server error" });
      }
    },
  );

  // The body parser's own failures (an image over the limit, above all) as
  // the same JSON errors as everything else here, not Express's HTML page.
  router.use(
    "/driver/background",
    (
      err: { status?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err.type === "entity.too.large") {
        return res.status(413).json({
          success: false,
          error: `Image too large (max ${GAMEPAD_BACKGROUND_MAX_BYTES} bytes)`,
        });
      }
      logger.error("[gamepad] background upload failed", err);
      return res
        .status(err.status ?? 500)
        .json({ success: false, error: "Could not read the upload" });
    },
  );

  /** `DELETE {basePath}/driver/background` — back to the plain controller. */
  router.delete("/driver/background", async (req, res) => {
    try {
      const session = await requireDriverSession(req, res);
      if (!session) return;
      const removed = await store.deleteSessionBackground(session.id);
      if (removed) runtimes.notifyBackgroundChanged(session.id, null);
      return res.json({ success: true });
    } catch (e) {
      logger.error("[gamepad] background delete failed", e);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error" });
    }
  });

  /**
   * The image behind a background URL. Public: phones load it with a plain
   * <img>/CSS url(), which carries no credentials, so the random per-upload
   * key is the capability — the same trust as the join URL. Served only
   * while the session is live, under the sniffed type, never sniffed again
   * by the browser.
   */
  router.get("/background/:key", async (req, res) => {
    try {
      const image = await store.getLiveBackgroundByKey(req.params.key);
      if (!image) {
        return res.status(404).json({ success: false, error: "Not found" });
      }
      res.set({
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-site",
      });
      return res.send(Buffer.from(image.data, "base64"));
    } catch (e) {
      logger.error("[gamepad] background fetch failed", e);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error" });
    }
  });

  return router;
};
