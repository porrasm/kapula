import express from "express";
import type { IncomingMessage } from "node:http";
import type { KapulaAuth, KapulaHostUser } from "@kapula/server";
import type { HostConfig } from "./config.js";

/**
 * The host page's identity, as plain as a reference host can have it. Two
 * modes, both cookie based:
 *
 * - dev auth (`KAPULA_DEV_AUTH=1`): `GET /auth/dev-login?email=` logs anyone
 *   in as that email — what the test suites use, never for a public host.
 * - owner token (`KAPULA_OWNER_TOKEN`): `POST /auth/login { token }` logs the
 *   one owner in; a self-hosted single-user instance.
 *
 * Drivers and players never touch this: they hold their own tokens.
 */

const COOKIE = "kapula_user";
const COOKIE_MAX_AGE_S = 180 * 24 * 3600;

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

export const createHostAuth = (config: HostConfig) => {
  // Dev users get ids in login order; the memory store has no user table.
  const devIds = new Map<string, number>();
  const OWNER_ID = 1;

  const userFor = (cookie: string | undefined): KapulaHostUser | null => {
    if (!cookie) return null;
    if (config.ownerToken && cookie === `owner:${config.ownerToken}`) {
      return { id: OWNER_ID, email: config.ownerEmail };
    }
    if (config.devAuth && cookie.startsWith("dev:")) {
      const email = cookie.slice(4).toLowerCase();
      let id = devIds.get(email);
      if (id === undefined) {
        id = OWNER_ID + 1 + devIds.size;
        devIds.set(email, id);
      }
      return { id, email };
    }
    return null;
  };

  const auth: KapulaAuth = {
    getUserFromRequest: async (req: IncomingMessage) =>
      userFor(parseCookies(req.headers.cookie)[COOKIE]),
  };

  const setCookie = (res: express.Response, value: string) =>
    res.cookie(COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      maxAge: COOKIE_MAX_AGE_S * 1000,
    });

  const router = express.Router();
  router.get("/dev-login", (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!config.devAuth) {
      res.status(404).json({ success: false, error: "Dev login is disabled" });
      return;
    }
    if (!email.includes("@")) {
      res.status(400).json({ success: false, error: "email required" });
      return;
    }
    setCookie(res, `dev:${email}`);
    res.redirect("/");
  });
  router.post("/login", express.json(), (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!config.ownerToken || token !== config.ownerToken) {
      res.status(401).json({ success: false, error: "Wrong token" });
      return;
    }
    setCookie(res, `owner:${token}`);
    res.json({ success: true });
  });
  router.post("/logout", (_req, res) => {
    res.clearCookie(COOKIE);
    res.json({ success: true });
  });
  router.get("/me", async (req, res) => {
    const user = await auth.getUserFromRequest(req);
    res.json({
      success: true,
      user: user ? { email: user.email } : null,
      devAuth: config.devAuth,
      ownerLogin: config.ownerToken !== null,
    });
  });

  return { auth, router };
};
