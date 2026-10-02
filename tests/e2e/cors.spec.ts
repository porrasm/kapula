import { test, expect } from "@playwright/test";
import { HOST_URL } from "../../playwright.config";
import { WsClient } from "./ws-utils";

/**
 * A game can be a browser client of this server (a Unity WebGL build served
 * from its own origin). These tests lock in what that requires: CORS on the
 * setup endpoint and an upgrade path that accepts a browser Origin header.
 * If any of these fail, a browser driver cannot connect at all.
 */
const GAME_ORIGIN = "https://game.example.com";
const SETUP_URL = `${HOST_URL}/api/kapula/driver/setup`;

test("driver setup preflight allows the game origin", async ({ request }) => {
  const res = await request.fetch(SETUP_URL, {
    method: "OPTIONS",
    headers: {
      Origin: GAME_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  expect(res.status()).toBeLessThan(300);
  expect([GAME_ORIGIN, "*"]).toContain(
    res.headers()["access-control-allow-origin"],
  );
  // The cors middleware reflects requested headers or allows all.
  const allowMethods = res.headers()["access-control-allow-methods"];
  if (allowMethods) {
    expect(allowMethods).toContain("POST");
  }
});

test("driver setup responses carry CORS headers, error statuses included", async ({
  request,
}) => {
  // Unknown code: the 404 body must still be readable cross-origin, or the
  // browser driver sees an opaque network error instead of the real message.
  const res = await request.post(SETUP_URL, {
    headers: {
      Origin: GAME_ORIGIN,
      "Content-Type": "application/json",
      "x-kapula-ratelimit-key": crypto.randomUUID(),
    },
    data: { setupCode: "ZZZZZZ" },
  });

  expect([GAME_ORIGIN, "*"]).toContain(
    res.headers()["access-control-allow-origin"],
  );
  const body = (await res.json()) as { success: boolean };
  expect(body.success).toBe(false);
});

test("ws upgrade accepts a browser Origin header", async () => {
  // Browsers always send Origin on WebSocket handshakes. WsClient.open
  // resolving proves the handshake was accepted with it; the application-
  // level close code that follows proves the Kapula code processed the
  // connection (instead of the socket being rejected at upgrade).
  const client = await WsClient.open("?role=driver&token=bogus-token", {
    headers: { Origin: GAME_ORIGIN },
    label: "origin-check",
  });

  const close = await client.waitForClose();
  expect(close.code).toBeGreaterThanOrEqual(4000);
  expect(close.code).toBeLessThan(5000);
});
