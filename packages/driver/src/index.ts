import {
  kapulaServerMessageSchema,
  type KapulaBackground,
  type KapulaBackgroundFit,
  type KapulaDriverClientMessage,
  type KapulaDriverSetupResponse,
  type KapulaPlayerInfo,
  type KapulaServerMessage,
  type KapulaSessionSnapshot,
} from "@kapula/protocol";
import type { kapulaSessionConfigSchema } from "@kapula/protocol";

export type DriverConfig = typeof kapulaSessionConfigSchema["_input"];
export type HttpOptions = { fetch?: typeof globalThis.fetch };
export class DriverHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Driver HTTP ${status}: ${typeof body === "object" && body !== null && "error" in body ? String(body.error) : "request failed"}`);
  }
}
const endpoint = (base: string, path: string) => `${base.replace(/\/$/, "")}/driver/${path}`;
async function request<T>(url: string, init: RequestInit, options: HttpOptions): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(url, init);
  const body = await response.json() as T & { success?: boolean };
  if (!response.ok || body.success === false) throw new DriverHttpError(response.status, body);
  return body;
}
export function setupDriver(baseUrl: string, options: HttpOptions & {
  setupCode: string; config?: DriverConfig; protocolVersion?: number;
}): Promise<KapulaDriverSetupResponse> {
  const { fetch: _fetch, ...body } = options;
  return request(endpoint(baseUrl, "setup"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, options);
}
export function createDriver(baseUrl: string, options: HttpOptions & {
  driverKey: string; config?: DriverConfig; replaceExisting?: boolean; protocolVersion?: number;
}): Promise<KapulaDriverSetupResponse> {
  const { driverKey, fetch: _fetch, ...body } = options;
  return request(endpoint(baseUrl, "create"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${driverKey}` },
    body: JSON.stringify(body),
  }, options);
}
export function postBackground(baseUrl: string, token: string, bytes: Uint8Array, fit: KapulaBackgroundFit = "cover", options: HttpOptions = {}): Promise<{ success: true; background: KapulaBackground }> {
  return request(`${endpoint(baseUrl, "background")}?fit=${encodeURIComponent(fit)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: new Blob([new Uint8Array(bytes)]),
  }, options);
}
export function deleteBackground(baseUrl: string, token: string, options: HttpOptions = {}): Promise<{ success: true }> {
  return request(endpoint(baseUrl, "background"), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }, options);
}

export interface DriverSocketEvent { data?: unknown; code?: number; reason?: string }
export interface DriverSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: DriverSocketEvent) => void): void;
}
export type DriverWebSocketConstructor = new (url: string) => DriverSocket;
type Message<T extends KapulaServerMessage["type"]> = Extract<KapulaServerMessage, { type: T }>;
export type DriverEvents = {
  snapshot: KapulaSessionSnapshot;
  state: Message<"state_changed">;
  player: { type: "joined" | "updated" | "connected" | "disconnected" | "left"; player: KapulaPlayerInfo };
  input: Message<"input">;
  motion: Message<"motion">;
  text: Message<"text">;
  error: Message<"error"> | Error;
  close: { code: number; reason: string; reconnecting: boolean };
  /** Every accepted wire message, after input deduplication. */
  message: KapulaServerMessage;
  open: undefined;
};
export const isFatalDriverClose = (code: number): boolean => [4000, 4001, 4004, 4005, 4010, 4011].includes(code);
export type ConnectDriverOptions = {
  wsUrl: string;
  token: string;
  WebSocket?: DriverWebSocketConstructor;
  /** Defaults to 250 ms, capped at 10 seconds; useful for deterministic tests. */
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Defaults to 25 seconds. */
  pingIntervalMs?: number;
};

export class DriverConnection {
  readonly players = new Map<string, KapulaPlayerInfo>();
  readonly ready: Promise<void>;
  private listeners = new Map<keyof DriverEvents, Set<(value: never) => void>>();
  private sequences = new Map<string, number>();
  private socket?: DriverSocket;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  constructor(private readonly options: ConnectDriverOptions) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Event-only consumers need not await ready, but can still observe errors.
    void this.ready.catch(() => {});
    void this.initialize();
  }
  on<K extends keyof DriverEvents>(event: K, listener: (value: DriverEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener as (value: never) => void);
    return () => { set.delete(listener as (value: never) => void); };
  }
  private emit<K extends keyof DriverEvents>(event: K, value: DriverEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
  private async initialize(): Promise<void> {
    try {
      const Constructor = this.options.WebSocket ?? (
        typeof process !== "undefined" && process.versions?.node
          ? (await import("ws")).default as unknown as DriverWebSocketConstructor
          : globalThis.WebSocket as unknown as DriverWebSocketConstructor
      );
      if (!this.stopped) this.open(Constructor);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectReady(error);
      this.emit("error", error);
    }
  }
  private open(Constructor: DriverWebSocketConstructor): void {
    const url = new URL(this.options.wsUrl);
    url.searchParams.set("role", "driver");
    if (this.options.token) url.searchParams.set("token", this.options.token);
    let socket: DriverSocket;
    try { socket = new Constructor(url.toString()); }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectReady(error); this.emit("error", error); return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.stopped || this.socket !== socket) return;
      this.resolveReady();
      this.pingTimer = setInterval(() => { if (socket.readyState === 1) this.send({ type: "ping" }); }, this.options.pingIntervalMs ?? 25_000);
      this.emit("open", undefined);
    });
    socket.addEventListener("message", (event) => {
      if (this.stopped || this.socket !== socket) return;
      let parsed;
      try { parsed = kapulaServerMessageSchema.safeParse(JSON.parse(String(event.data))); }
      catch { this.emit("error", new Error("Invalid driver message JSON")); return; }
      if (!parsed.success) { this.emit("error", new Error("Invalid driver server message")); return; }
      this.fold(parsed.data);
    });
    socket.addEventListener("error", () => this.emit("error", new Error("Driver WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      clearInterval(this.pingTimer);
      this.socket = undefined;
      const code = event.code ?? 1006;
      const reconnecting = !this.stopped && !isFatalDriverClose(code);
      if (!reconnecting) {
        this.stopped = true;
        this.rejectReady(new Error(`Driver closed: ${code}`));
      } else {
        const delay = Math.min((this.options.reconnectDelayMs ?? 250) * 2 ** Math.min(this.retries++, 20), this.options.reconnectMaxDelayMs ?? 10_000);
        this.reconnectTimer = setTimeout(() => { if (!this.stopped) this.open(Constructor); }, delay);
      }
      this.emit("close", { code, reason: event.reason ?? "", reconnecting });
    });
  }
  private fold(msg: KapulaServerMessage): void {
    if (msg.type === "input") {
      if (msg.seq <= (this.sequences.get(msg.playerId) ?? -1)) return;
      this.sequences.set(msg.playerId, msg.seq);
    }
    if (msg.type === "snapshot") {
      this.retries = 0;
      this.players.clear();
      for (const player of msg.snapshot.players) this.players.set(player.playerId, { ...player });
      this.emit("snapshot", msg.snapshot);
    } else if (msg.type === "player_joined" || msg.type === "player_updated") {
      const player = { ...msg.player };
      this.players.set(player.playerId, player);
      this.emit("player", { type: msg.type === "player_joined" ? "joined" : "updated", player });
    } else if (msg.type === "player_connected" || msg.type === "player_disconnected" || msg.type === "player_left") {
      const previous = this.players.get(msg.playerId);
      if (previous) {
        const type = msg.type === "player_left" ? "left" : msg.type === "player_connected" ? "connected" : "disconnected";
        const player = type === "left" ? previous : { ...previous, connected: type === "connected" };
        if (type === "left") this.players.delete(msg.playerId);
        else this.players.set(msg.playerId, player);
        this.emit("player", { type, player });
      }
    } else if (msg.type === "state_changed") this.emit("state", msg);
    else if (msg.type === "input") this.emit("input", msg);
    else if (msg.type === "motion") this.emit("motion", msg);
    else if (msg.type === "text") this.emit("text", msg);
    else if (msg.type === "error") this.emit("error", msg);
    this.emit("message", msg);
  }
  send(msg: KapulaDriverClientMessage): void {
    if (this.socket?.readyState !== 1) throw new Error("Driver socket is not open");
    this.socket.send(JSON.stringify(msg));
  }
  start(): void { this.send({ type: "start" }); }
  pause(): void { this.send({ type: "pause" }); }
  resume(): void { this.send({ type: "resume" }); }
  end(): void { this.send({ type: "end" }); }
  lobby(): void { this.send({ type: "lobby" }); }
  setSchema(playerId: string | undefined, schemaId: string): void { this.send({ type: "set_schema", playerId, schemaId }); }
  kick(playerId: string): void { this.send({ type: "kick", playerId }); }
  message(playerId: string | undefined, payload: unknown): void { this.send({ type: "message", playerId, payload }); }
  /** Dispose permanently: cancel keepalive and reconnect, then close the socket. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.rejectReady(new Error("Driver connection disposed"));
    this.socket?.close();
  }
}
export function connectDriver(options: ConnectDriverOptions): DriverConnection {
  return new DriverConnection(options);
}
