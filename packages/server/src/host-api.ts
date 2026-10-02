import express from "express";
import { z } from "zod";
import {
  kapulaLinkedEmailsSchema,
  kapulaPlayerNameSchema,
  kapulaSessionMetadataSchema,
} from "@kapula/protocol";
import type { KapulaContext, KapulaHostUser } from "./context.js";
import { KapulaServiceError, type KapulaService } from "./service.js";

/**
 * JSON API for the host page — the logged-in user who creates sessions and
 * manages driver keys. One route per operation, `POST <basePath>/host/<op>`
 * with the operation's input as the JSON body; the user comes from the
 * host's `auth` adapter, so an anonymous call is a 401. Answers are
 * `{ success: true, data }` or `{ success: false, error, code }` with the
 * same statuses as the player API (400 invalid, 404 not found, 409
 * conflict). A host with its own RPC layer may wrap `service` instead of
 * mounting this.
 */

/** Session ids are decimal strings (bigserial values in SQL stores). */
const sessionIdSchema = z.string().regex(/^\d{1,18}$/);

const OPERATIONS = {
  createSession: z
    .object({ metadata: kapulaSessionMetadataSchema.optional() })
    .optional(),
  getMySession: z.undefined().optional(),
  listMySessions: z.undefined().optional(),
  endMySession: z.object({ sessionId: sessionIdSchema.optional() }).optional(),
  kickPlayer: z.object({
    playerId: z.string().min(1),
    /** Which of the host's sessions; the web-hosted one when omitted. */
    sessionId: sessionIdSchema.optional(),
  }),
  createDriverKey: z.object({
    name: z.string().trim().min(1).max(64),
    linkedEmails: kapulaLinkedEmailsSchema.optional(),
  }),
  listDriverKeys: z.undefined().optional(),
  setDriverKeyEmails: z.object({
    id: z.number().int().positive(),
    linkedEmails: kapulaLinkedEmailsSchema,
  }),
  revokeDriverKey: z.object({ id: z.number().int().positive() }),
  listPrivateSessions: z.undefined().optional(),
  joinPrivateSession: z.object({
    sessionId: sessionIdSchema,
    name: kapulaPlayerNameSchema.optional(),
  }),
} as const;

export type KapulaHostOperation = keyof typeof OPERATIONS;
export const KAPULA_HOST_OPERATIONS = Object.keys(OPERATIONS) as KapulaHostOperation[];

type Input<O extends KapulaHostOperation> = z.infer<(typeof OPERATIONS)[O]>;

const STATUS_BY_CODE = { not_found: 404, conflict: 409 } as const;

export const createHostRouter = (
  ctx: KapulaContext,
  service: KapulaService,
): express.Router => {
  const { auth, logger } = ctx;
  const router = express.Router();

  const run = async (
    op: KapulaHostOperation,
    user: KapulaHostUser,
    input: unknown,
  ): Promise<unknown> => {
    switch (op) {
      case "createSession": {
        const i = input as Input<"createSession">;
        return service.createHostedSession({ ownerId: user.id, metadata: i?.metadata });
      }
      case "getMySession":
        return service.getMySession(user.id);
      case "listMySessions":
        return service.listMySessions(user.id);
      case "endMySession": {
        const i = input as Input<"endMySession">;
        await service.endMySession({ ownerId: user.id, sessionId: i?.sessionId });
        return { success: true as const };
      }
      case "kickPlayer": {
        const i = input as Input<"kickPlayer">;
        await service.kickPlayer({ ownerId: user.id, ...i });
        return { success: true as const };
      }
      case "createDriverKey": {
        const i = input as Input<"createDriverKey">;
        return service.createDriverKey({ userId: user.id, ...i });
      }
      case "listDriverKeys":
        return service.listDriverKeys(user.id);
      case "setDriverKeyEmails": {
        const i = input as Input<"setDriverKeyEmails">;
        return service.setDriverKeyEmails({
          userId: user.id,
          keyId: i.id,
          linkedEmails: i.linkedEmails,
        });
      }
      case "revokeDriverKey": {
        const i = input as Input<"revokeDriverKey">;
        await service.revokeDriverKey({ userId: user.id, keyId: i.id });
        return { success: true as const };
      }
      case "listPrivateSessions":
        return service.listPrivateSessions({ userId: user.id, email: user.email });
      case "joinPrivateSession": {
        const i = input as Input<"joinPrivateSession">;
        return service.joinPrivateSession({ userId: user.id, email: user.email, ...i });
      }
    }
  };

  router.post("/:op", express.json(), async (req, res) => {
    const op = req.params.op as KapulaHostOperation;
    const schema = OPERATIONS[op];
    if (!schema) {
      res.status(404).json({ success: false, error: "Unknown operation", code: "not_found" });
      return;
    }
    try {
      const user = await auth.getUserFromRequest(req);
      if (!user) {
        res.status(401).json({ success: false, error: "Unauthorized", code: "unauthorized" });
        return;
      }
      // An empty body means "no input"; express.json leaves it as {}.
      const raw =
        req.body && typeof req.body === "object" && Object.keys(req.body).length === 0
          ? undefined
          : req.body;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: `Invalid input for ${op}`,
          code: "bad_request",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        return;
      }
      res.json({ success: true, data: await run(op, user, parsed.data) });
    } catch (e) {
      if (e instanceof KapulaServiceError) {
        res.status(STATUS_BY_CODE[e.code]).json({ success: false, error: e.message, code: e.code });
        return;
      }
      logger.error(`[kapula] host ${op} failed`, e);
      res.status(500).json({ success: false, error: "Internal server error", code: "internal" });
    }
  });

  return router;
};
