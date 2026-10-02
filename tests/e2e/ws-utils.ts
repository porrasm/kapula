import type { APIRequestContext } from "@playwright/test";
import { WebSocket } from "ws";
import { kapulaServerMessageSchema } from "@kapula/protocol";
import { HOST_URL } from "../../playwright.config";

export type ServerMessage = { type: string } & Record<string, unknown>;
export type CloseEvent = { code: number; reason: string };

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every WsClient opened during a spec run; used by the final contract test to
 * assert that no server message ever failed kapulaServerMessageSchema.
 */
export const allClients: WsClient[] = [];

/**
 * Protocol-level WebSocket client for any of the three roles. Unlike the
 * browser clients it exposes raw sends, close codes and a message cursor so
 * tests can assert on exact wire behavior.
 */
export class WsClient {
  readonly label: string;
  readonly messages: ServerMessage[] = [];
  /** Frames the server sent that do not match kapulaServerMessageSchema. */
  readonly invalidMessages: unknown[] = [];
  closeEvent: CloseEvent | null = null;
  private ws: WebSocket;
  private waiters: {
    pred: (msg: ServerMessage) => boolean;
    after: number;
    resolve: (msg: ServerMessage) => void;
  }[] = [];
  private closeWaiters: ((c: CloseEvent) => void)[] = [];

  private constructor(ws: WebSocket, label: string) {
    this.ws = ws;
    this.label = label;
  }

  /**
   * Opens a socket to /api/gamepad/ws with the given query string. Resolves on
   * the WS handshake; the server's auth rejections complete the handshake and
   * then close with a 4xxx code, so use waitForClose() to observe them.
   */
  static open(
    query: string,
    opts: {
      headers?: Record<string, string>;
      label?: string;
      /** Absolute URL to open instead of building one — e.g. the setup response's wsUrl. */
      url?: string;
      /** false plays dead: the socket never answers the server's ping frames. */
      autoPong?: boolean;
    } = {},
  ): Promise<WsClient> {
    const url =
      opts.url ?? `${HOST_URL.replace(/^http/, "ws")}/api/gamepad/ws${query}`;
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: opts.headers,
      autoPong: opts.autoPong ?? true,
    });
    const client = new WsClient(ws, opts.label ?? query);
    allClients.push(client);

    ws.on("message", (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(data)) as ServerMessage;
      } catch {
        client.invalidMessages.push(String(data));
        return;
      }
      if (!kapulaServerMessageSchema.safeParse(msg).success) {
        client.invalidMessages.push(msg);
      }
      const index = client.messages.length;
      client.messages.push(msg);
      client.waiters = client.waiters.filter((waiter) => {
        if (index < waiter.after || !waiter.pred(msg)) return true;
        waiter.resolve(msg);
        return false;
      });
    });
    ws.on("close", (code, reason) => {
      client.closeEvent = { code, reason: String(reason) };
      for (const resolve of client.closeWaiters) resolve(client.closeEvent);
      client.closeWaiters = [];
    });

    return new Promise((resolve, reject) => {
      ws.once("open", () => {
        // Handshake failures after this point surface as close events.
        ws.on("error", () => {});
        resolve(client);
      });
      ws.once("error", (e) => reject(e));
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Cursor into the message log; pass to waitFor/countSince for "from now on". */
  mark(): number {
    return this.messages.length;
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string) {
    this.ws.send(data);
  }

  /** First message at index >= after matching the predicate, past or future. */
  waitFor(
    pred: (msg: ServerMessage) => boolean,
    opts: { after?: number; timeoutMs?: number } = {},
  ): Promise<ServerMessage> {
    const after = opts.after ?? 0;
    const existing = this.messages.slice(after).find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `[${this.label}] timed out waiting for message; last messages: ` +
              JSON.stringify(this.messages.slice(-8)),
          ),
        );
      }, opts.timeoutMs ?? 8000);
      this.waiters.push({
        pred,
        after,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  waitForType(type: string, opts: { after?: number; timeoutMs?: number } = {}) {
    return this.waitFor((m) => m.type === type, opts);
  }

  /** Every message received since the cursor, in arrival order. */
  since(after: number): ServerMessage[] {
    return this.messages.slice(after);
  }

  /** Messages received since the cursor that match the predicate. */
  countSince(after: number, pred: (msg: ServerMessage) => boolean): number {
    return this.messages.slice(after).filter(pred).length;
  }

  waitForClose(timeoutMs = 8000): Promise<CloseEvent> {
    if (this.closeEvent) return Promise.resolve(this.closeEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${this.label}] timed out waiting for close`)),
        timeoutMs,
      );
      this.closeWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }

  /**
   * Ping round trip: once the pong arrives the server has consumed everything
   * this socket sent before the ping (same-socket messages are handled in
   * order, and the relevant handlers run synchronously up to their sends).
   */
  async settle(): Promise<void> {
    const cursor = this.mark();
    this.send({ type: "ping" });
    await this.waitForType("pong", { after: cursor });
  }

  /**
   * Round-trips a ping and asserts nothing matching `pred` arrived before the
   * pong: the server handles messages for one socket in order, so this proves
   * earlier sends were consumed without the given response.
   */
  async expectNoResponse(pred: (msg: ServerMessage) => boolean): Promise<void> {
    const cursor = this.mark();
    this.send({ type: "ping" });
    await this.waitForType("pong", { after: cursor });
    const offending = this.messages
      .slice(cursor)
      .filter((m) => m.type !== "pong" && pred(m));
    if (offending.length > 0) {
      throw new Error(
        `[${this.label}] expected silence but got: ${JSON.stringify(offending)}`,
      );
    }
  }

  close() {
    this.ws.close();
  }
}

// --- HTTP helpers (host API + driver API) ---

/**
 * A host API answer in one shape for the specs: `data` is the payload, and a
 * failure gives `error` with the message and an upper-case code
 * (NOT_FOUND, CONFLICT, BAD_REQUEST, UNAUTHORIZED) under `error.data.code`.
 */
export type HostResult = {
  status: number;
  data: any;
  error: any;
};

const upperCode = (code: string | undefined, status: number): string =>
  (code ?? (status === 404 ? "not_found" : status === 409 ? "conflict" : "bad_request")).toUpperCase();

/** `POST /api/gamepad/host/<op>`: the host page's operations, as the logged-in user. */
export const hostCall = async (
  request: APIRequestContext,
  op: string,
  input?: unknown,
): Promise<HostResult> => {
  const res = await request.post(`/api/gamepad/host/${op}`, { data: input ?? {} });
  const body = await res.json();
  const status = res.status();
  if (body.success) return { status, data: body.data, error: undefined };
  return {
    status,
    data: undefined,
    error: { message: body.error, data: { code: upperCode(body.code, status) } },
  };
};

export const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Dev-login into the request context; returns the session Cookie header. */
export const devLogin = async (
  request: APIRequestContext,
  email: string,
): Promise<string> => {
  await request.get(`/auth/dev-login?email=${encodeURIComponent(email)}`);
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === "kapula_user");
  if (!cookie) throw new Error("dev-login did not set a kapula_user cookie");
  return `kapula_user=${cookie.value}`;
};

export const createHostSession = async (
  request: APIRequestContext,
): Promise<{ sessionId: string; setupCode: string }> => {
  const result = await hostCall(request, "createSession");
  if (result.error) {
    throw new Error(`createSession failed: ${result.error.message}`);
  }
  return result.data;
};

export type DriverSetupBody = {
  success: boolean;
  error?: string;
  issues?: string[];
  /** Present on a rejected protocol version: the versions the server serves. */
  supported?: number[];
  protocolVersion?: number;
  sessionId?: string;
  joinCode?: string;
  joinUrl?: string;
  driverToken?: string;
  wsPath?: string;
  wsUrl?: string;
  metadata?: string;
};

/**
 * The endpoint is rate limited (10 calls/min per bucket). In dev the backend
 * accepts a per-call bucket header, and this helper defaults to a fresh
 * bucket per call so tests never throttle each other — the rate-limit spec
 * passes a fixed `rateLimitKey` to deliberately fill one bucket.
 */
export const driverSetup = async (
  request: APIRequestContext,
  setupCode: string,
  config?: unknown,
  rateLimitKey?: string,
  protocolVersion?: number,
): Promise<{ status: number; body: DriverSetupBody }> => {
  const res = await request.post("/api/gamepad/driver/setup", {
    headers: { "x-gamepad-ratelimit-key": rateLimitKey ?? crypto.randomUUID() },
    data: {
      setupCode,
      ...(config !== undefined ? { config } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    },
  });
  return { status: res.status(), body: await res.json() };
};

/**
 * `POST /api/gamepad/driver/create` — the driver-key entry point. Same shape
 * of response as driverSetup, and the same per-call rate-limit bucket.
 */
export const driverCreate = async (
  request: APIRequestContext,
  key: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: DriverSetupBody }> => {
  const res = await request.post("/api/gamepad/driver/create", {
    headers: {
      "x-gamepad-ratelimit-key": crypto.randomUUID(),
      Authorization: `Bearer ${key}`,
    },
    data: body ?? {},
  });
  return { status: res.status(), body: await res.json() };
};

/**
 * The player JSON API, answered in the same shape as the host helper so a
 * test reads `.data` and `.error` the same way: `data` is the payload, and
 * a failure gives `error` with the message and an upper-case code derived
 * from the status (404 → NOT_FOUND, 409 → CONFLICT, 400 → BAD_REQUEST).
 */
const playerApiResult = async (res: {
  status: () => number;
  json: () => Promise<any>;
}): Promise<HostResult> => {
  const status = res.status();
  const body = await res.json();
  if (body.success) {
    const { success: _success, ...data } = body;
    return { status, data, error: undefined };
  }
  const code =
    status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "BAD_REQUEST";
  return { status, data: undefined, error: { message: body.error, data: { code } } };
};

export const getJoinInfo = async (
  request: APIRequestContext,
  joinCode: string,
): Promise<HostResult> => {
  const result = await playerApiResult(
    await request.get(`/api/gamepad/join-info/${encodeURIComponent(joinCode)}`),
  );
  return { ...result, data: result.data?.info };
};

export const getPlayerStatus = async (
  request: APIRequestContext,
  token: string,
): Promise<HostResult> => {
  const result = await playerApiResult(
    await request.post("/api/gamepad/player/status", { data: { token } }),
  );
  return { ...result, data: result.data?.status };
};

export const joinSession = async (
  request: APIRequestContext,
  joinCode: string,
  name?: string,
): Promise<HostResult> =>
  playerApiResult(
    await request.post("/api/gamepad/join", {
      data: name === undefined ? { joinCode } : { joinCode, name },
    }),
  );
