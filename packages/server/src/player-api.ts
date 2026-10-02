import express from "express";
import { gamepadJoinRequestSchema, gamepadPlayerStatusRequestSchema } from "@kapula/protocol";
import type { GamepadContext } from "./context.js";
import { GamepadServiceError, type GamepadService } from "./service.js";

/**
 * Plain JSON API for the player phone: look a join code up, join, verify a
 * stored credential. Public (players have no account), same error shape as
 * the driver API, so the phone bundle depends on nothing but these three
 * routes and the WebSocket — whoever hosts it. Documented in GAMEPAD.md
 * ("Player HTTP API").
 */

const STATUS_BY_CODE = { not_found: 404, conflict: 409 } as const;

const invalid = (res: express.Response, what: string, issues: { path: PropertyKey[]; message: string }[]) =>
  res.status(400).json({
    success: false,
    error: `Invalid ${what}`,
    issues: issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  });

export const createPlayerRouter = (
  ctx: GamepadContext,
  service: GamepadService,
): express.Router => {
  const { logger } = ctx;
  const router = express.Router();

  /** Runs a handler; service errors become their status, anything else a 500. */
  const guarded =
    (what: string, run: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await run(req, res);
      } catch (e) {
        if (e instanceof GamepadServiceError) {
          res.status(STATUS_BY_CODE[e.code]).json({ success: false, error: e.message });
          return;
        }
        logger.error(`[gamepad] ${what} failed`, e);
        res.status(500).json({ success: false, error: "Internal server error" });
      }
    };

  router.get(
    "/join-info/:joinCode",
    guarded("join info", async (req, res) => {
      const parsed = gamepadJoinRequestSchema.shape.joinCode.safeParse(req.params.joinCode);
      if (!parsed.success) return invalid(res, "join code", parsed.error.issues);
      res.json({ success: true, info: await service.getJoinInfo(parsed.data) });
    }),
  );

  router.post(
    "/join",
    express.json(),
    guarded("join", async (req, res) => {
      const parsed = gamepadJoinRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, "join request", parsed.error.issues);
      res.json({ success: true, ...(await service.joinByCode(parsed.data)) });
    }),
  );

  router.post(
    "/player/status",
    express.json(),
    guarded("player status", async (req, res) => {
      const parsed = gamepadPlayerStatusRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, "status request", parsed.error.issues);
      res.json({ success: true, status: await service.getPlayerStatus(parsed.data.token) });
    }),
  );

  return router;
};
