import type { APIRequestContext } from "@playwright/test";
import { HOST_URL } from "../../playwright.config";

type SetupResponse = {
  success: boolean;
  error?: string;
  sessionId: string;
  joinCode: string;
  joinUrl: string;
  driverToken: string;
  wsPath: string;
  /** The driver socket as an absolute URL; what a real driver connects to. */
  wsUrl: string;
  protocolVersion: number;
  /** The host's session metadata, verbatim; absent when none was set. */
  metadata?: string;
};

type ServerMessage = { type: string } & Record<string, unknown>;

/**
 * Minimal driver client for the tests: what a real game would implement
 * against the documented HTTP + WebSocket protocol. Runs in the Playwright
 * Node process using the built-in WebSocket (Node 22+).
 */
export class TestDriver {
  readonly messages: ServerMessage[] = [];
  private ws: WebSocket | null = null;
  private waiters: {
    pred: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
  }[] = [];

  static async setup(
    request: APIRequestContext,
    setupCode: string,
    config?: unknown,
  ): Promise<SetupResponse> {
    const response = await request.post("/api/kapula/driver/setup", {
      // A unique dev-only rate-limit bucket per call: every test run shares
      // localhost and the dev backend keeps its 10/min window across runs,
      // so unscoped calls would throttle unrelated tests and repeat runs.
      headers: { "x-kapula-ratelimit-key": crypto.randomUUID() },
      data: { setupCode, ...(config !== undefined ? { config } : {}) },
    });
    const body = (await response.json()) as SetupResponse;
    if (!body.success) {
      throw new Error(`Driver setup failed: ${body.error}`);
    }
    return body;
  }

  /** Takes the setup response's `wsUrl` (absolute) or its `wsPath`. */
  async connect(target: string): Promise<void> {
    const url = /^wss?:\/\//.test(target)
      ? target
      : HOST_URL.replace(/^http/, "ws") + target;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        this.messages.push(msg);
        this.waiters = this.waiters.filter((waiter) => {
          if (!waiter.pred(msg)) return true;
          waiter.resolve(msg);
          return false;
        });
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WS failed")), {
        once: true,
      });
    });
  }

  send(msg: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Resolves with the first past or future message matching the predicate. */
  waitFor(
    pred: (msg: ServerMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<ServerMessage> {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for driver message")),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
