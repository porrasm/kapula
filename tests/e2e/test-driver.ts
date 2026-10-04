import { setupDriver, connectDriver, type DriverConnection, type DriverConfig } from "@kapula/driver";
import type { KapulaDriverClientMessage, KapulaDriverSetupResponse } from "@kapula/protocol";
import type { APIRequestContext } from "@playwright/test";
import { HOST_URL } from "../../playwright.config";

type SetupResponse = KapulaDriverSetupResponse;

type ServerMessage = { type: string } & Record<string, unknown>;

/**
 * Thin SDK adapter retaining the tests' message history and waitFor API.
 */
export class TestDriver {
  readonly messages: ServerMessage[] = [];
  private ws: DriverConnection | null = null;
  private waiters: {
    pred: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
  }[] = [];

  static async setup(
    request: APIRequestContext,
    setupCode: string,
    config?: unknown,
  ): Promise<SetupResponse> {
    return setupDriver(`${HOST_URL}/api/kapula`, {
      setupCode,
      config: config as DriverConfig | undefined,
      fetch: async (url, init) => {
        const response = await request.post(String(url), {
          headers: { ...init?.headers as Record<string, string>, "x-kapula-ratelimit-key": crypto.randomUUID() },
          data: JSON.parse(String(init?.body)),
        });
        return new Response(await response.text(), { status: response.status(), headers: response.headers() });
      },
    });
  }

  /** Takes the setup response's `wsUrl` (absolute) or its `wsPath`. */
  async connect(target: string): Promise<void> {
    const url = /^wss?:\/\//.test(target)
      ? target
      : HOST_URL.replace(/^http/, "ws") + target;
    const ws = connectDriver({ wsUrl: url, token: new URL(url).searchParams.get("token") ?? "" });
    this.ws = ws;
    ws.on("message", (message) => {
      const msg = message as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.pred(msg)) return true;
        waiter.resolve(msg);
        return false;
      });
    });
    await ws.ready;
  }

  send(msg: KapulaDriverClientMessage) {
    this.ws?.send(msg);
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
