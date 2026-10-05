import { test, expect } from "@playwright/test";
import {
  connectDriver, isFatalDriverClose, setupDriver, createDriver,
  postBackground, deleteBackground, DriverHttpError,
  type DriverSocketEvent, type DriverConnection,
} from "@kapula/driver";
import { kapulaSessionConfigSchema, type KapulaPlayerInfo, type KapulaServerMessage } from "@kapula/protocol";

class FakeSocket {
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((event: DriverSocketEvent) => void)[]>();
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  addEventListener(type: string, listener: (event: DriverSocketEvent) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  fire(type: string, event: DriverSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() { this.readyState = 1; this.fire("open"); }
  receive(value: unknown) { this.fire("message", { data: JSON.stringify(value) }); }
  send(data: string) { this.sent.push(data); }
  close(code = 1000) { this.readyState = 3; this.fire("close", { code, reason: "test" }); }
}
const player = (playerId: string): KapulaPlayerInfo => ({
  playerId, name: `Player ${playerId}`, color: "#ff0000", ready: false, connected: true, schemaId: "gamepad",
});
const snapshot = (players: KapulaPlayerInfo[]): KapulaServerMessage => ({ type: "snapshot", snapshot: {
  protocolVersion: 2, sessionId: "session", state: "waiting_for_players", driverConnected: true,
  config: kapulaSessionConfigSchema.parse({}), players,
} });
let connections: DriverConnection[];
test.beforeEach(() => { FakeSocket.sockets = []; connections = []; });
test.afterEach(() => { connections.forEach(connection => connection.close()); });
function connect(options: Partial<Parameters<typeof connectDriver>[0]> = {}) {
  const connection = connectDriver({ wsUrl: "ws://example.test/ws?other=1&token=old", token: "new token", WebSocket: FakeSocket, reconnectDelayMs: 5, ...options });
  connections.push(connection);
  const socket = FakeSocket.sockets.at(-1)!;
  socket.open();
  return { connection, socket };
}

test("snapshots authoritatively rebuild players and events patch the map before callbacks", () => {
  const { connection, socket } = connect();
  const events: string[] = [];
  connection.on("player", event => {
    events.push(event.type);
    expect(connection.players.has(event.player.playerId)).toBe(event.type !== "left");
  });
  socket.receive(snapshot([player("a"), player("b")]));
  socket.receive({ type: "player_updated", player: { ...player("a"), name: "Renamed", ready: true } });
  expect(connection.players.get("a")?.name).toBe("Renamed");
  socket.receive({ type: "player_disconnected", playerId: "a" });
  expect(connection.players.get("a")?.connected).toBe(false);
  socket.receive({ type: "player_connected", playerId: "a" });
  expect(connection.players.get("a")?.connected).toBe(true);
  socket.receive({ type: "player_joined", player: player("c") });
  socket.receive({ type: "player_left", playerId: "b" });
  socket.receive(snapshot([{ ...player("c"), connected: false }]));
  expect([...connection.players.keys()]).toEqual(["c"]);
  expect(connection.players.get("c")?.connected).toBe(false);
  expect(events).toEqual(["updated", "disconnected", "connected", "joined", "left"]);
});

test("input dedupe is per player and survives reconnect and replacement snapshots", async () => {
  const { connection, socket } = connect();
  const received: string[] = [];
  const wire: string[] = [];
  connection.on("input", msg => received.push(`${msg.playerId}:${msg.seq}`));
  connection.on("message", msg => { if (msg.type === "input") wire.push(`${msg.playerId}:${msg.seq}`); });
  const input = (target: FakeSocket, playerId: string, seq: number) => target.receive({ type: "input", playerId, seq, controls: {} });
  input(socket, "a", 5); input(socket, "a", 5); input(socket, "a", 4); input(socket, "b", 0);
  socket.close(1006);
  await expect.poll(() => FakeSocket.sockets.length).toBe(2);
  const replacement = FakeSocket.sockets[1]; replacement.open();
  replacement.receive(snapshot([player("a")]));
  input(replacement, "a", 5); input(replacement, "a", 6); input(replacement, "b", 0); input(replacement, "b", 1);
  expect(received).toEqual(["a:5", "b:0", "a:6", "b:1"]);
  expect(wire).toEqual(received);
});

for (const code of [4000, 4001, 4004, 4005, 4010, 4011]) {
  test(`fatal close ${code} never reconnects`, async () => {
    const { connection, socket } = connect();
    const closes: unknown[] = [];
    connection.on("close", event => closes.push(event));
    socket.close(code);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(isFatalDriverClose(code)).toBe(true);
    expect(FakeSocket.sockets).toHaveLength(1);
    expect(closes).toEqual([{ code, reason: "test", reconnecting: false }]);
  });
}

test("transient closes use capped exponential backoff, reset by an authoritative snapshot", async () => {
  for (const code of [1000, 1001, 1006, 1011, 1012, 1013]) expect(isFatalDriverClose(code)).toBe(false);
  const { connection, socket } = connect({ reconnectDelayMs: 30, reconnectMaxDelayMs: 60 });
  const closes: boolean[] = [];
  connection.on("close", event => closes.push(event.reconnecting));
  socket.close(1012);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(FakeSocket.sockets).toHaveLength(1);
  await expect.poll(() => FakeSocket.sockets.length).toBe(2);
  const second = FakeSocket.sockets[1]; second.open(); second.close(1006);
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(FakeSocket.sockets).toHaveLength(2);
  await expect.poll(() => FakeSocket.sockets.length).toBe(3);
  const third = FakeSocket.sockets[2]; third.open(); third.receive(snapshot([])); third.close(1006);
  await expect.poll(() => FakeSocket.sockets.length, { intervals: [10] }).toBe(4);
  expect(closes).toEqual([true, true, true]);
});

test("helpers, token URL, application ping, unsubscribe and disposal", async () => {
  const { connection, socket } = connect({ pingIntervalMs: 5 });
  await connection.ready;
  expect(new URL(socket.url).searchParams.get("token")).toBe("new token");
  expect(new URL(socket.url).searchParams.get("other")).toBe("1");
  expect(new URL(socket.url).searchParams.get("role")).toBe("driver");
  connection.start(); connection.pause(); connection.resume(); connection.end(); connection.lobby();
  connection.setSchema(undefined, "alt"); connection.kick("a"); connection.message("a", { round: 2 });
  expect(socket.sent.map(value => JSON.parse(value))).toEqual([
    { type: "start" }, { type: "pause" }, { type: "resume" }, { type: "end" }, { type: "lobby" },
    { type: "set_schema", schemaId: "alt" }, { type: "kick", playerId: "a" },
    { type: "message", playerId: "a", payload: { round: 2 } },
  ]);
  await expect.poll(() => socket.sent.some(value => value === '{"type":"ping"}')).toBe(true);
  let called = 0;
  const unsubscribe = connection.on("snapshot", () => called++);
  unsubscribe(); socket.receive(snapshot([])); expect(called).toBe(0);
  socket.close(1006); connection.close();
  const sent = socket.sent.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(FakeSocket.sockets).toHaveLength(1); expect(socket.sent).toHaveLength(sent);
  expect(() => connection.start()).toThrow("not open");
});

test("state, motion, text and protocol/transport errors have typed events", () => {
  const { connection, socket } = connect();
  const events: string[] = [];
  connection.on("state", msg => events.push(msg.state));
  connection.on("text", msg => events.push(msg.text));
  connection.on("motion", msg => events.push(`motion:${msg.samples.length}`));
  connection.on("error", msg => events.push(msg instanceof Error ? "invalid" : msg.message));
  socket.receive({ type: "state_changed", state: "paused", reason: "driver_command" });
  socket.receive({ type: "text", playerId: "a", controlId: "chat", text: "hello" });
  socket.receive({ type: "motion", playerId: "a", samples: [[0, 0, 0, 1, 0, 0, 0]] });
  socket.receive({ type: "error", code: "invalid_state", message: "refused" });
  socket.fire("message", { data: "{" });
  socket.receive({ type: "input", seq: -1 });
  socket.fire("error");
  expect(events).toEqual(["paused", "hello", "motion:1", "refused", "invalid", "invalid", "invalid"]);
  expect(events.filter(value => value === "invalid")).toHaveLength(3);
});

test("HTTP helpers preserve paths, auth, optional config and binary bytes; failures retain status", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ success: true, sessionId: "s" });
  };
  await setupDriver("https://example.test/api/kapula/", { setupCode: "ABCDEF", protocolVersion: 2, config: {}, fetch });
  await createDriver("https://example.test/api/kapula", { driverKey: "key", replaceExisting: true, fetch });
  const bytes = new Uint8Array([1, 2, 3]);
  await postBackground("https://example.test/api/kapula", "token", bytes, "contain", { fetch });
  await deleteBackground("https://example.test/api/kapula", "token", { fetch });
  expect(calls.map(call => call.url)).toEqual([
    "https://example.test/api/kapula/driver/setup", "https://example.test/api/kapula/driver/create",
    "https://example.test/api/kapula/driver/background?fit=contain", "https://example.test/api/kapula/driver/background",
  ]);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ setupCode: "ABCDEF", protocolVersion: 2, config: {} });
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ replaceExisting: true });
  expect(calls[1].init.headers).toMatchObject({ Authorization: "Bearer key" });
  expect(calls[2].init.headers).toMatchObject({ Authorization: "Bearer token" });
  expect([...new Uint8Array(await (calls[2].init.body as Blob).arrayBuffer())]).toEqual([...bytes]);
  expect(calls[3].init.method).toBe("DELETE");
  await expect(setupDriver("https://example.test", { setupCode: "BAD", fetch: async () => Response.json({ success: false, error: "Unknown code" }, { status: 404 }) })).rejects.toMatchObject({ status: 404, body: { error: "Unknown code" } });
  expect(new DriverHttpError(401, { error: "Unauthorized" }).message).toContain("Unauthorized");
});
