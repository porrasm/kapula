# @kapula/driver

Typed HTTP and WebSocket client for Kapula protocol v2, for Node and browsers.
Pass the **API base URL**, including its mount path (usually `/api/kapula`).
Install with `npm install @kapula/driver`.

```ts
import { setupDriver, connectDriver } from "@kapula/driver";

const session = await setupDriver("http://localhost:4310/api/kapula", {
  setupCode: "ABCDEF", // host-issued code
  protocolVersion: 2,
  config: { maxPlayers: 8 },
});
console.log("Join:", session.joinUrl);
const driver = connectDriver({
  wsUrl: session.wsUrl,
  token: session.driverToken,
});
driver.on("snapshot", snapshot => console.log(snapshot.state));
driver.on("player", ({ type, player }) => console.log(type, player.name));
driver.on("input", ({ playerId, controls }) => console.log(playerId, controls));
driver.on("error", error => console.error(error.message));
driver.on("close", ({ code, reconnecting }) => console.log(code, reconnecting));
await driver.ready;
driver.message(undefined, { welcome: true });
// When the application exits:
driver.close();
```

`createDriver(baseUrl, { driverKey, config?, replaceExisting?, protocolVersion? })`
creates a session using an owner's driver key instead of a setup code. HTTP
helpers reject with `DriverHttpError` (`status`, `body`) on refused requests.
An optional `fetch` in HTTP options supports custom transports.
`postBackground(baseUrl, token, Uint8Array, fit)` uploads an image (`cover`,
`contain` or `fill`); `deleteBackground(baseUrl, token)` removes it.

The connection offers `send(KapulaDriverClientMessage)`, `start`, `pause`,
`resume`, `end`, `lobby`, `setSchema(playerId | undefined, schemaId)`, `kick`,
and `message(playerId | undefined, payload)`. `on(event, callback)` returns an
unsubscribe function. Events are `snapshot` (snapshot object), `state` (wire
state change), `player` (kind and full player info), `input`, `motion`, `text`,
`error` (protocol error or Error), `close` (code, reason, reconnecting), `open`,
and `message` (accepted wire message). Register listeners before awaiting
`ready`, which resolves on the first socket open. Sends while disconnected
throw; commands are never queued or replayed.

`players` is a map keyed by player ID. Every snapshot replaces its contents;
player events patch it before callbacks run. Input frames at or below the
highest sequence for that player are discarded, including across reconnects.
Snapshots reset reconnect backoff, but do not reset input sequence tracking.

Transient closes reconnect after 250 ms, doubling to a 10 s cap. Codes 4000,
4001, 4004, 4005, 4010 and 4011 stop permanently. Application pings run every
25 s while connected. `close()` cancels timers and reconnects permanently.
Node defaults to `ws`; browsers default to the global WebSocket. Pass
`WebSocket: YourConstructor` to inject a browser socket or fake implementation.
`reconnectDelayMs`, `reconnectMaxDelayMs` and `pingIntervalMs` override timings.
