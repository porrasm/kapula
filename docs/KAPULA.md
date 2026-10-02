# Kapula — design and protocol

> Carried over from the monorepo's `backend/src/apps/gamepad/GAMEPAD.md` on
> 2026-10-02, when the gamepad app became the Kapula packages, and renamed
> with them: "gamepad" below means a physical controller, everything that
> meant the app says Kapula, and the wire is protocol version 2
> (`/api/kapula`, `x-kapula-ratelimit-key`, `kpk_` keys). Where the text
> mentions monorepo-only parts (the tRPC router, the Postgres adapter,
> `instance.ts`, the HostPanel/DebugDriver/HelpPage pages) those stayed in
> the monorepo; the reference host in `apps/host` plays the host's part
> here. Path map: `common/src/apps/gamepad.ts` → `packages/protocol/src/index.ts`,
> `backend/src/apps/gamepad/*` → `packages/server/src/*`,
> `frontend/src/apps/gamepad/player/*` → `packages/phone/src/*`, the tests →
> `tests/unit` and `tests/e2e`.

# Kapula

Phones become game controllers. An authenticated **host** creates a session in
the web app; an external **driver** (a game or desktop client — e.g. the
planned tank game) claims it over HTTP and receives player input over a
WebSocket; **players** join anonymously from their phones with a join code.

This file is the reference for driver authors and for future work. The wire
protocol (zod schemas + types) lives in `packages/protocol/src/index.ts` and is
shared by the backend, the frontend and the tests.

## Roles and codes

| Role   | Auth                                  | Transport |
| ------ | ------------------------------------- | --------- |
| host   | gauth cookie (session owner)          | tRPC + WS `role=host&sessionId=…` |
| driver | setup code (or a driver key) → driver token | HTTP setup/create + WS `role=driver&token=…` |
| player | join code → player token (localStorage) | HTTP join (`POST /api/kapula/join`) + WS `role=player&token=…` |

Codes are 6 chars from an unambiguous alphabet (no `0/O/1/I/L`). They are
credentials: the **setup code** is single-use (consumed by the driver's setup
call and exchanged for a long random driver token); the **join code** admits
new players while the lobby is open, but reconnection uses the player token,
never the code.

## Session state machine

```
not_initialized ──driver setup──▶ waiting_for_players ──driver start──▶ in_progress
                                    ▲                                   │      ▲
                                    │ driver lobby     driver pause /   ▼      │ driver resume
                                    └───────────────── driver drop    paused ──┘
any active state ──driver end / host end / driver away 3 min / 24h idle──▶ ended
```

- Only the **driver** starts, pauses, resumes and ends the game (the host's
  ready screen is a lobby, not a remote control). The host's "End session"
  button and the cleanup cron are the escape hatches.
- Driver disconnect during `in_progress` auto-pauses with reason
  `driver_disconnected`; a reconnected driver must send `resume` explicitly.
- **Sessions are not kept alive for a missing driver.** A session without a
  driver socket for `KAPULA_DRIVER_LOST_TIMEOUT_MS` (3 min — counted from
  setup if the driver never connects, or from the drop) is treated as
  permanently lost and ended with reason `driver_lost`. Players are sent
  straight back to the landing page (with a one-line reason; nothing of an
  ended session is ever shown as ongoing — the landing page verifies a stored
  credential with `POST /api/kapula/player/status` before showing "you are in a
  game"), and the host's session info disappears. The in-memory watchdog
  (`armDriverLostTimer` in runtime.ts) fires on time; the
  `gamepad_session_driver_disconnected_at` column plus the per-minute cleanup
  cron are the durable backstop across backend restarts (boot marks every
  live session driver-less). Recovery is deliberately a *new* session, made
  fast by the **roster** (below) rather than by keep-alive logic.
- **Private sessions** (`config.private`, default false) — for a remote
  control nobody else should grab. Who may join: the session's owner, plus,
  for a session a driver key opened, every email linked to that key (a
  `TEXT[]` on `gamepad_driver_key`, migration 55, edited in the host panel's
  Driver keys section; lowercased, and people without an account yet can be
  listed — the check is against the logged-in user's auth email). A private
  session is invisible to the join-code path (`findPublicSessionByJoinCode`:
  `GET /api/kapula/join-info/:code` answers null and `POST /api/kapula/join`
  is 404, so a code does not even confirm it exists); the users allowed
  in see it in "Your private sessions" on the landing page
  (`kapulaListPrivateSessions`, named after the key) and join with one tap
  (`kapulaJoinPrivateSession`, re-checking access). The setup response's
  `joinUrl` is the landing page instead of a join link. Access is checked
  at join time only: unlinking an email (or revoking the key) keeps that
  person out from then on, but a player already in keeps playing until they
  leave or are kicked — players carry no user link. The owner keeps access
  regardless. A private session made with a setup code has no key, so only
  its owner may join.
- **Sessions without a lobby** (`config.skipLobby`, default false) are for
  sessions without rounds — a remote control, a jukebox. The driver may
  `start` with nobody joined or ready (`minPlayers` and ready flags are
  ignored by `getStartError`), and joins stay open while the game runs or
  is paused (it implies `allowLateJoin`). The server does not start the
  session on its own — the driver sends `start` right after connecting (the
  debug driver does exactly that), so phones never see a lobby; `lobby`
  still works. Rejected together with a `roster`, whose point is a
  complete, ready player set.
- Players may join in `waiting_for_players` (until `maxPlayers`), and in a
  running or paused session when the driver set `config.allowLateJoin`
  (default false — a game that cannot cope with a player appearing mid-match
  must not be handed one; never in a roster session, where the roster fixes
  the player set). The rule is `acceptsJoins` in `logic.ts`, and
  the join info's `acceptingPlayers` reports it so the join screen never
  has to reason about states itself. A late joiner lands straight on the
  controller — `ready` is meaningless to them. A join
  takes only the code: the server assigns a free `Player N` name and the first
  free palette color, which the player customizes in the lobby
  (`update_profile`). Names and colors are unique per session
  (case-insensitive names, DB partial unique indexes as the race backstop).
- **Roster sessions** (`config.roster`, the lost-session recovery path): the
  driver predefines the players (name + color, e.g. the ones it remembers
  from the session that was lost). The join screen lists them and a player
  picks the slot that is theirs (`POST /api/kapula/join` with `name`; a taken
  slot is refused); name and color are locked in the lobby
  (`update_profile` → `profile_locked`); `minPlayers` = `maxPlayers` = roster
  size, so `start` is allowed only once every slot is filled, connected and
  ready. The admin debug driver's ended view offers "Set up again with the
  same players" (`buildRecoveryConfig`) as the reference implementation.
- **Hosting and playing are separate**: the session owner is never joined
  automatically — creating a session must not force the host into the game.
  A host who wants to play joins with the join code like anyone else.
- `ready` and `update_profile` are lobby-only; the control schema can be
  switched at any point in a live session — lobby, `in_progress` or `paused`
  — from the picker in the in-game menu. The driver sees the new id in
  `player_updated` and gets input under it from the next frame on; `seq`
  keeps increasing across the switch (the phone mounts a fresh controller
  for the new layout, but the counter belongs to the player session).
- Cleanup cron (`gamepad-session-cleanup`, every minute): sessions idle > 24h
  end, `not_initialized` sessions idle > 30 min end, sessions whose driver
  has been away > 3 min end (`driver_lost`).

## Driver HTTP API

`POST /api/kapula/driver/setup` (no auth, rate limited 10/min/IP)

```jsonc
{
  "setupCode": "ABC234",
  "protocolVersion": 1,             // optional; the version the driver speaks.
                                    // Omitted means "whatever this server
                                    // serves". A version it does not serve is
                                    // refused with 400 { success: false,
                                    // error: "Unsupported protocol version",
                                    // supported: [1] } before the setup code
                                    // is looked up, so the code survives.
  "config": {                       // optional; omit for a generic gamepad
    "game": "Tank Game",
    "driverAppUuid": "7d3a2c1e-…",  // optional; a UUID generated once and
                                    // shipped with the game — phones file the
                                    // layouts players edit under it (see
                                    // "Player layout editor")
    "minPlayers": 1,                // default 1
    "maxPlayers": 8,                // default 8, hard cap 12
    "allowPhysicalGamepad": false,  // true adds a "Real gamepad" option next
                                    // to the schemas (see "Physical
                                    // gamepads" below)
    "disallowLayoutCustomization": false, // true removes the player layout
                                    // editor and ignores stored edits: the
                                    // controller is exactly as described
                                    // (see "Exact positions" below)
    "schemas": [                    // 1–32 control schemas; players pick one
      {
        "id": "tank",
        "name": "Tank",
        "orientation": "auto",      // optional layout hint: "auto" (default)
                                    // | "landscape" | "portrait"
        "controls": [               // 1–16 controls, unique kebab-case ids,
                                    // ordered most-important-first (see
                                    // "Controller layout" below)
          { "type": "joystick", "id": "drive",    // mode "full" (x+y) default
            "zone": "left", "size": "large" },    // optional layout hints
          { "type": "joystick", "id": "aim", "mode": "x" },  // "x"|"y"|"dpad"
                                    // |"relative" (see "Joystick modes")
          { "type": "button", "id": "fire", "label": "Fire", "zone": "right",
            "shape": "rect" },      // optional "round" (default) | "rect"
          { "type": "button", "id": "jump", "label": "Jump",
            "x": 85, "y": 40 },     // optional exact center, % of the
                                    // controller's width/height (see
                                    // "Exact positions")
          { "type": "gyro", "id": "lean", "range": 45 },  // tilt sensor (max 1
                          // per schema); mode "full"|"x"|"y", range in degrees
          { "type": "text", "id": "answer", "label": "Answer",  // a button
            "maxLength": 80 }       // that opens the player's keyboard; sent
                                    // whole on Send (see "Text input")
        ]
      },
      {
        "id": "touchpad",
        "name": "Touchpad",
        "controls": [
          { "type": "raw", "id": "touch" }  // the background as one touch
                          // surface, under any other controls (see
                          // "Raw touch")
        ]
      },
      {
        "id": "mouse",
        "name": "Mouse",
        "controls": [
          { "type": "touchpad", "id": "pad",  // a laid-out touch surface;
            "aspect": 1.5 },        // width/height 0.25–4, default 1 (see
                                    // "Touchpad")
          { "type": "joystick", "id": "scroll", "mode": "y" },
          { "type": "button", "id": "left", "label": "Left", "shape": "rect" },
          { "type": "button", "id": "right", "label": "Right", "shape": "rect" }
        ]
      }
    ],
    "private": false,               // true: only the owner + the key's
                                    // linked emails, logged in, may join —
                                    // never by code (see "Private sessions")
    "skipLobby": false,             // true: no rounds — start with nobody
                                    // joined, joins always open (see
                                    // "Sessions without a lobby")
    "allowLateJoin": false,         // true lets players join while the game
                                    // runs (see "Session state machine");
                                    // ignored in roster sessions
    "capabilities": [],             // optional opt-in features the driver
                                    // supports, as free strings (max 16, 32
                                    // chars each). Kept verbatim; unknown
                                    // capabilities are ignored, so declaring
                                    // one an older server or phone does not
                                    // know is safe. Reserved so far:
                                    // "webrtc" (planned direct transport).
    "colors": ["#FF6B6B", "…"],     // optional palette; unique, length >= maxPlayers
    "roster": [                     // optional predefined players (recovery):
      { "name": "Player 1", "color": "#FF6B6B" },  // join = pick a slot; names
      { "name": "Player 2", "color": "#6BCB77" }   // unique (case-insens.),
    ]                               // colors unique + from the palette;
                                    // min/maxPlayers = roster size (omit them)
  }
}
```

Response: `{ success, protocolVersion, sessionId, joinCode, joinUrl,
driverToken, wsPath, wsUrl, metadata? }`. `joinUrl` is ready to render as a QR
code. Store `driverToken` — it is the only way to reconnect the driver.
`wsUrl` is the driver socket as an absolute URL (`wsPath` is the same socket,
relative); both are built from the same origin as `joinUrl` — the bare domain
in production, the request host in dev — so an embedded driver that does not
know its own base URL can connect from the response alone.
A driver may also post a background image for the phones over HTTP; see
"Background image" below.
`protocolVersion` is the version the session speaks (the requested one when
the request asked for it); the `snapshot` message repeats it, so a driver that
reconnects without the setup response still knows.

`metadata` is free-form text (max `KAPULA_METADATA_MAX_LENGTH` = 4096 chars)
the host optionally attached when creating the session, delivered verbatim and
uninterpreted — e.g. a launcher app passing game configuration to the game.
Absent when the host set none, and delivered only in this response: a driver
that needs it after a reconnect must store it with the driver token.

### Driver keys

The setup-code flow needs a person in a browser: create a session in the web
app, read six characters into the game. Fine for a launcher that automates it,
a chore for a standalone driver (a PC virtual-gamepad client, a native game)
that would otherwise reopen the website on every launch. A **driver key** is
issued once to a user and turns the flow into "click start, show the QR code".

`POST /api/kapula/driver/create` (rate limited like `/driver/setup`)

```jsonc
// Authorization: Bearer kpk_…
{
  "config": { ... },        // optional, same config as /driver/setup
  "protocolVersion": 1,     // optional, same rule as /driver/setup
  "replaceExisting": false  // default false; see below
}
```

The response is a setup response, field for field, and the session is
indistinguishable from a hosted one afterwards (the key's owner is the session
owner, so it shows up in their host panel — as its own card, named after the
key — and "End session" works).
`metadata` is never set — there was no host to attach any.

- **One active session per slot.** Every driver key is a slot of its own,
  and the web-hosted (setup-code) session is one more: a user can host a
  game on the web while their living-room PC keeps its remote-control
  session open. A second create with the same key is `409 "This driver key
  already has an active session"` unless `replaceExisting: true`, which ends
  *that key's* session first (its players get `state_changed` with reason
  `host_ended` and close code 4005) — never the hosted one or another key's.
  A game restarting after a crash sends `replaceExisting: true`. The session
  records its key in `gamepad_session_driver_key_id` (migration 54; NULL for
  hosted sessions). The web app's `kapulaCreateSession` still allows one
  hosted session per user.
- Host-side tRPC for multiple sessions: `kapulaListMySessions` lists every
  active session the user owns (hosted first, each with `driverKeyId` /
  `driverKeyName`); `kapulaGetMySession` is the hosted slot only;
  `kapulaEndMySession({sessionId?})` and `kapulaKickPlayer({playerId,
  sessionId?})` target the given session when it is the caller's (else
  `NOT_FOUND`), or the hosted one without an id.
- Keys live in `gamepad_driver_key` (migration 37) as **SHA-256 hashes** —
  the plain `kpk_` + 32 random bytes value is returned exactly once, by
  `kapulaCreateDriverKey`, and is unrecoverable after that. Lookup hashes the
  presented key and matches on the unique index, so no secret is ever compared
  byte by byte. `last_used_at` is stamped on every successful create.
- Self-service tRPC, all owner-scoped: `kapulaCreateDriverKey({name})`,
  `kapulaListDriverKeys` (name, display prefix, created, last used — never
  the key), `kapulaRevokeDriverKey({id})`. Revoking is immediate and
  permanent; a revoked key is `401` like an unknown one. The host panel has a
  "Driver keys" section for all three.
- Linked emails (`kapulaCreateDriverKey({name, linkedEmails?})`,
  `kapulaSetDriverKeyEmails({id, linkedEmails})`, listed by
  `kapulaListDriverKeys`) say who besides the owner may join the key's
  private sessions — see "Private sessions" above. Max 20 per key.
- A key is a credential for *creating sessions in its owner's name* (and for
  ending the one that key has running with `replaceExisting`). It is not a login
  and grants nothing else. Precedent for the shape: `app_token` (migrations
  7–8, `auth/integration-middleware.ts`), which is admin-issued rather than
  self-service, hence a separate table.

## Player HTTP API

The phone's own three routes, next to the driver API and like it outside
any user auth (players have no account): the player web app depends on
nothing but these and the WebSocket, whoever hosts it. Same answer shape as
the driver API — `{ success: true, … }`, or `{ success: false, error }` with
400 (invalid input, listing `issues`), 404 or 409. The schemas live in
`packages/protocol/src/index.ts` ("Player HTTP API"); the frontend client is
`packages/phone/src/player-api.ts`. The host page's own operations
(creating a session, driver keys, kicking) stay on tRPC.

- `GET /api/kapula/join-info/:joinCode` → `{ success, info }`: everything
  the join screen shows before joining (`kapulaJoinInfoSchema`: state,
  game, player count and cap, `acceptingPlayers`, free colors, schema names,
  the roster with `taken` flags). `info` is null for a code that leads
  nowhere — unknown, ended, or private. Never exposes tokens.
- `POST /api/kapula/join` with `{ joinCode, name? }` → `{ success,
  sessionId, playerId, playerToken }` (`kapulaJoinRequestSchema`,
  `kapulaJoinResultSchema`). The server assigns the name and color; in a
  roster session `name` picks the slot. 404 for an unknown or private
  session, 409 with the reason when the session is full, not accepting
  players, or the slot is taken.
- `POST /api/kapula/player/status` with `{ token }` → `{ success, status }`:
  whether a stored credential still leads somewhere
  (`kapulaPlayerStatusSchema`: session id and state, game, the player's
  name and color), null when not. The token travels in the body, never in
  the URL.

## Protocol version 2 — pre-release

Version 1 was the gamepad app's wire, frozen on 2026-09-13 and unlocked on
2026-10-02 for the extraction into the Kapula packages. Version 2 is the
Kapula wire: the same messages under the renamed paths (`/api/kapula`), header
(`x-kapula-ratelimit-key`) and key prefix (`kpk_`). A driver that asks for
version 1 at setup is refused with `supported: [2]`; a driver that asks for
nothing gets 2. Until the first stable Kapula release the shape may still
change and every known driver author is told before a breaking change lands.
At that release version 2 freezes, for good, with exactly the rules below.

Within a version, the rules already apply:

- **Additive changes only.** New optional fields, new message types, new
  values in the `state_changed.reason` and `error.code` enums, new control
  types, new config fields with defaults. Nothing is removed, renamed, or
  given a new meaning; nothing optional becomes required.
- **Clients must ignore what they do not know** — unknown message types,
  unknown fields, unknown enum values, control ids they did not declare (see
  "Rules for driver authors"). The phone and the server already do: an
  unknown type fails the discriminated union and is dropped.
- **Anything else is a new version**, negotiated at setup: a driver asks with
  `protocolVersion` and a server that does not serve it refuses with the list
  it does serve. Both versions can then be served side by side.

`KAPULA_PROTOCOL_VERSION` in `packages/protocol/src/index.ts` is the number;
the setup response and every `snapshot` carry it.

## WebSocket protocol

Path `/api/kapula/ws` (same host). All messages are JSON. Every role receives
a full `snapshot` message on (re)connect — clients must treat it as the source
of truth and apply later events on top. The snapshot carries
`protocolVersion` alongside the session state, so the version is available on
every connection, not only in the setup response. Message shapes: see
`kapulaServerMessageSchema`, `kapulaPlayerClientMessageSchema` and
`kapulaDriverClientMessageSchema` in `packages/protocol/src/index.ts`.

- Player → server: `input` (see below), `motion` (see "Raw motion stream"),
  `text {controlId, text}` (see "Text input"), `set_ready`, `select_schema`,
  `update_profile {name?, color?}` (lobby-only; rejected with an `error` when
  the name/color is taken), `leave` (allowed in **any** state — a paused or
  stuck session must never trap a player; frees the name/color slot, kills
  the player token and closes the socket with a normal 1000), `ping`.
- Driver → server: `start`, `pause`, `resume`, `lobby`, `end`, `message`
  (small payload to one player or all — see "Driver → player payloads"),
  `set_schema {playerId?, schemaId}`, `kick {playerId}`, `ping`.
- `kick` removes a player for good: the same bookkeeping as their own `leave`
  (`removePlayer` in runtime.ts — the slot's name and color are freed, the
  token dies, everyone gets `player_left`), and their socket closes with
  `4011`. Not a ban: nothing stops them joining again with the join code.
  `unknown_player` when they are already gone. The host can do the same from
  the host panel through `kapulaKickPlayer` — they see the roster but have
  no driver socket.
- `lobby` takes a running or paused session back to `waiting_for_players`
  between rounds: every player's `ready` is cleared in the same step (each
  one broadcast as a `player_updated`), so the next `start` waits for a fresh
  ready-up, players can change name, color and layout again, and new players
  can join as in any lobby.
- `set_schema` puts a player (or every active player, when `playerId` is
  omitted) on one of the config's schemas — for games whose controls change by
  phase: menu, driving, on foot. Same state rule as the player's own
  `select_schema` (any live state), the same `player_updated` broadcast, and
  the same validation (`unknown_schema`; `unknown_player` when the id is not
  in this session). Disconnected-but-active players are included, so a
  reconnecting phone comes back on the schema the game expects. It is a push,
  not a lock: the player can still switch from their in-game menu, and the
  driver learns about that the same way.
- Server → all: `snapshot`, `state_changed {state, reason}` — `reason` is
  always present, one of `driver_command`, `driver_disconnected`,
  `driver_lost`, `host_ended`, `inactivity` — roster events
  (`player_joined/updated/connected/disconnected`, `player_left {playerId}` —
  a permanent exit, remove the player; distinct from `player_disconnected`,
  which is a reconnectable drop — and `driver_connected/…`),
  `error {code, message}`.
- `error.code` is a closed enum (`kapulaErrorCodeSchema`): `invalid_state`
  (the action is not allowed in this state), `cannot_start` (not everyone is
  joined, connected and ready), `profile_taken` (name or color is another
  player's), `profile_locked` (roster session: names and colors are fixed),
  `unknown_schema` (no schema with that id in the config), `unknown_player`
  (no such player in this session). `message` is the
  human-readable text. Adding a code is an additive change, so treat an
  unknown one as a generic error and show `message`.
- Server → driver only: `input {playerId, seq, controls}`, `motion
  {playerId, samples}`, `text {playerId, controlId, text}`.
- Server → players only: `background_changed {background}` — the driver
  posted (`{url, fit}`) or removed (`null`) its background image. The
  snapshot carries the current one as `background`, absent when there is
  none (see "Background image").

### Input model

Players send **full state snapshots**, not deltas: `{type:"input", seq,
controls: {"drive": {"x":0.4,"y":-1}, "fire": true}}`. Joystick axes are in
[-1, 1], **y positive downwards** (screen coordinates). A joystick's value
shape follows its `mode` (see "Joystick modes" below): `"full"` and
`"relative"` send `{x, y}`, `"x"`/`"y"` send only their own axis (`{x}` /
`{y}`), and `"dpad"` sends one of 9 short direction codes — `"c"` (centered)
or `"u"`/`"ur"`/`"r"`/`"dr"`/`"d"`/`"dl"`/`"l"`/`"ul"` (kept to 1–2 chars
because they ride in every full-state frame; `dpadToVector` in common maps
them to unit vectors). Movement is throttled to ~30 fps; button
presses/releases flush immediately as their own frames. Every analog value is
rounded to **3 decimals** on the phone (`roundAxis` in `axis-utils.ts`, shared
by touch sticks, tilt and real gamepads): finer than a thumb can aim, and
roughly half the bytes of a raw double in every frame.
Dpad direction changes behave like button edges — sent only when the state
changes, so a dpad control costs a fraction of an analog stick's bandwidth.
A `gyro` control streams the phone's tilt as a virtual joystick in the same
frames — full mode `{x, y}`, single-axis modes `{x}` / `{y}` — where x is
roll (screen's right edge down = positive) and y is pitch (screen's top edge
toward the player = positive), scaled so `range` degrees of tilt from the
calibrated neutral is full deflection. Yaw is deliberately not in the
protocol (compass-dependent, drifts). Tilt is continuous movement, so it
rides the ~30 fps throttle like a dragged stick. A `raw` control sends the
list of fingers down, `[{id, x, y}, …]` (see "Raw touch").
Drivers must keep only the highest `seq` per player and drop stale frames.
`seq` is **owned by the phone**: a per-player strictly increasing integer for
the lifetime of the player, across reconnects and schema switches. The server
relays it as is and silently drops any frame whose `seq` does not exceed the
last one it relayed for that player (`runtime.lastInputSeq`). The phone keeps
one counter per player session (`packages/phone/src/seq-counter.ts`),
seeded with the wall-clock millisecond of page load and advanced by 1 per
frame: the server caps frames at 120/s, so the counter always advances slower
than the clock and a reload always resumes above everything the previous load
sent. Expect large numbers and gaps, never a restart. Because the server never
rewrites `seq`, a future direct transport (WebRTC) can carry the same frames
and the driver can dedupe across both paths with the same rule.
Server limits: 8 KB per message, 120 input frames/s per player (drop), 600/s
(disconnect). Input is relayed only in `in_progress` and only to the driver.

### Keepalive

Neither side may assume a silent socket is alive: a phone that walks out of
range or a driver machine that sleeps leaves an "open" connection until TCP
gives up, and until then input is relayed into a dead driver and the
driver-lost clock never starts.

- **Server → clients:** a WebSocket ping every 30 s
  (`KEEPALIVE_INTERVAL_MS` in `signaling.ts`, overridable outside production
  with `KAPULA_WS_KEEPALIVE_MS` — the e2e test needs it short). A client
  that has not answered by the next tick is `terminate()`d, so a silent
  socket is gone within two ticks and its role is freed the usual way
  (`player_disconnected`, or the driver-away clock). Browsers, Node's
  built-in `WebSocket` and the `ws` package answer ping frames automatically;
  a driver on a library that does not must answer them itself.
- **Phone → server:** an application-level `{"type":"ping"}` every 25 s
  (`useKapulaSocket.ts`). Protocol-level ping frames are invisible to the
  reverse proxies in between, which drop sockets that have carried no data —
  a waiting lobby or a paused game otherwise flickers through a
  disconnect/reconnect. Drivers should do the same; the server answers with
  `pong`.
- Pings are deliberately **not** session activity (`countsAsActivity` in
  `logic.ts`, unit-tested): a controller left open on a desk must not hold
  its session past the 24 h idle rule.

### Joystick modes

A `joystick` control's `mode` picks both what it reports and how the phone
draws it:

| mode | reports | rendered as |
| --- | --- | --- |
| `"full"` (default) | `{x, y}` | round pad, knob springs back to its center |
| `"relative"` | `{x, y}` | square pad, no fixed center |
| `"x"` / `"y"` | `{x}` / `{y}` | pill track along that axis |
| `"dpad"` | `"c"`/`"u"`/`"ur"`/… | square with four arrows |

`"relative"` is the precision mode. There is no home position: the point the
finger lands on becomes that touch's neutral, and the value is the drag from
there — full deflection at `RELATIVE_STICK_TRAVEL` (0.35) of the pad's shorter
side, clamped to that circle. Two consequences a driver should count on:

- **Every touch starts at `{x: 0, y: 0}`.** Lifting and putting the thumb back
  re-centers instead of snapping to wherever the fixed center happened to be,
  so a player can reposition mid-game without the aim jumping. Good for aiming,
  cameras and cursors; a walking stick usually still wants `"full"`.
- **The drag may leave the pad.** Only the touch-*down* has to be inside it;
  the pointer is captured, so the drag keeps steering off the edge of the pad
  (and off other controls) until the finger lifts. Release sends
  `{x: 0, y: 0}` like any other stick.

Values are ordinary axes otherwise — same range, same y-down convention, same
~30 fps throttle — so a driver that already handles `"full"` needs no new code
to read a `"relative"` pad.

### Physical gamepads

`config.allowPhysicalGamepad: true` adds a **Real gamepad** option to the
schema picker (lobby and in-game menu): the player pairs a controller with
the phone (Bluetooth or USB) and the phone becomes a bridge, polling it
through the browser Gamepad API. Selecting it is an ordinary
`select_schema` with the reserved id `PHYSICAL_GAMEPAD_SCHEMA_ID`
(`"physical-gamepad"`; a driver schema may not use it — setup rejects the
config), gated server-side by `isSelectableSchemaId` (unknown when the flag
is off), and the driver sees it in `player_updated.schemaId` like any
schema. Input then arrives in ordinary `input` frames with the fixed
`PHYSICAL_GAMEPAD_CONTROLS` set — the W3C standard mapping, in the existing
value shapes plus one new one:

| id | value | Gamepad API source |
| --- | --- | --- |
| `left-stick`, `right-stick` | `{x, y}` like a `"full"` joystick | axes 0/1, 2/3 |
| `dpad` | a direction code like a `"dpad"` joystick | buttons 12–15 folded |
| `a`, `b`, `x`, `y`, `lb`, `rb`, `back`, `start`, `ls`, `rs`, `home` | boolean | buttons 0–5, 8–11, 16 |
| `lt`, `rt` | **number** in [0, 1] (analog pull) | buttons 6, 7 `.value` |

The bare number is the only protocol addition (`kapulaInputValueSchema`
accepts a scalar in [-1, 1]); a driver only meets it after opting in, so the
protocol version is unchanged. Every id is present in every frame (missing
hardware reads as released). The phone (`physical-gamepad-utils.ts`, pure and
unit-tested; `usePhysicalGamepad.ts` owns the rAF poll loop) applies a radial
deadzone with rescaling (`STICK_DEADZONE` 0.1) so a resting controller sends
nothing, rounds axes like every other analog source, sends button/dpad changes
as immediate edges and stick/trigger movement through the ~30 fps throttle,
and reads a lost controller as everything released. A non-standard-mapping
controller is read by the same indices best-effort (the player sees a
warning). Browsers hide controllers until a button is pressed, so the
bridge screen (`PhysicalGamepadPanel.tsx`, whose readout the debug driver's
player card reuses) tells the player to press one; the lobby's "Try the
controller" shows the same readout. There is no orientation lock and no
layout editor in this mode — the phone is not the controller.

### Close codes

`4000` bad request · `4001` unauthorized · `4004` not found (dead token) ·
`4005` session ended · `4008` rate limit · `4010` replaced by a newer
connection for the same identity (a player opening the controller on a second
device takes the slot over) · `4011` removed from the session (kicked; the
phone drops its stored credential, since the token died with the slot). Clients should not reconnect on these; anything
else is transient and the frontend retries with backoff. Frames over 64 KB
close the connection with the standard `1009` (the 8 KB protocol limit drops
smaller oversized frames silently, without closing).

### Background image

`POST /api/kapula/driver/background?fit=cover|contain|fill` with
`Authorization: Bearer <driverToken>` and the image itself as the body
(PNG, JPEG, GIF or WebP, at most `KAPULA_BACKGROUND_MAX_BYTES` = 2 MB)
puts it behind the controller on every phone. The type is sniffed from the
magic bytes (`sniffImageType` in `logic.ts`), never taken from the claimed
Content-Type — the bytes are served back under the sniffed type, so nothing
else (SVG with its scripts above all) can ever be served from the URL. The
answer is `{ success, background: { url, fit } }`; `DELETE` on the same path
removes it. Errors: 401 (no/dead token — checked before the body is read),
400 (bad `fit`), 413 (too large), 415 (not one of the four formats), 429
(over 30 uploads a minute per session).

- One image per session (`gamepad_session_background`, migration 53, stored
  base64 in a TEXT column): a new upload replaces it. Every upload gets a
  fresh random key and the URL is `/api/kapula/background/{key}`, so a URL
  names one version of the image and is served `immutable`.
- The GET is public — a phone loads it with a plain CSS `url()`, which
  carries no credentials — so the 64-hex-char key is the capability, the
  same trust as the join URL. It serves only while the session is live; the
  cleanup cron deletes the rows of ended sessions.
- Phones get `background_changed` on every change and `background` in the
  snapshot on (re)connect; the driver gets neither (it has the HTTP answer),
  nor does the host. `Controller` draws it on the controller box — the area
  under the header, the same box `raw` coordinates and `x`/`y` positions are
  measured in — in the in-game screen and the lobby trial. `fit` is CSS
  `background-size`: `cover` (default) crops, `contain` letterboxes, `fill`
  stretches, which is the one that lines image pixels up with touch
  coordinates on every aspect ratio.
- Additive under version 1: a session without an image sends exactly the
  snapshot it did before (the field is absent, not null), and only players
  receive the new message type.

### Driver → player payloads

The `message` payload is opaque to the server — deliberately: it relays and
never interprets. The conventions are therefore pure client-side agreements
(`packages/phone/src/driver-payload.ts`, unit-tested), and anything
outside them is delivered to the phone and ignored, which is what makes the
payload a good carrier for a game's own state.

- `{ "vibrateMs": n }` — `navigator.vibrate` on the phone, clamped to 1 s. A
  player on the physical-gamepad schema gets the Gamepad API haptic actuator
  instead (`rumblePhysicalGamepad` in `usePhysicalGamepad.ts`): their phone is
  lying on the table, so buzzing it is pointless. Haptics are best-effort —
  missing on many pads and on Safari, and a rejected `playEffect` is ignored.
- `{ "text": "You are Red" }` — a line above the controls for
  `DRIVER_TEXT_MS` (4 s), max 64 characters, truncated rather than dropped.
  `{ "text": null }` (or an empty string) clears it immediately; it also
  expires on its own, so a driver that forgets to clear one does not leave it
  up for the rest of the match. It renders above the controller and never
  moves a control.

Both are additive conventions under version 1: a driver that sends neither is
unaffected, and a phone that predates them ignores the keys.

### Rules for driver authors

The contract a driver may rely on, and the assumptions that will break it.
These are the rules protocol version 1 is built around; a driver that follows
them keeps working through every additive change.

1. **The `snapshot` is authoritative; events patch it.** One arrives on every
   (re)connect. Connection state is reported three ways — `driver_connected` /
   `driver_disconnected`, `state_changed.reason`, and `snapshot.driverConnected`
   — so on any doubt (a reconnect, a missed event, a race between the two)
   trust the snapshot and rebuild from it.
2. **Ignore what you do not know.** Unknown message types and unknown fields
   are additive changes, not errors — drop them and carry on. The same goes
   for control ids you did not declare: the server validates id *syntax*, not
   membership, so a frame from the schema a player just left can arrive right
   after a switch.
3. **Read control values by shape, not by id alone.** The same id can carry a
   boolean in one schema and a number in another (`lt`/`rt` are analog in the
   physical-gamepad set), and a joystick's shape follows its `mode`:
   `{x, y}`, `{x}`, `{y}` or a dpad string.
4. **Keep only the highest `seq` per player.** It is phone-owned and strictly
   increasing for the player's lifetime, across reconnects and schema
   switches; expect large numbers and gaps, never a restart (see "Input
   model").
5. **Input arrives only in `in_progress`.** Do not act on frames that were
   buffered before a pause: check the state you are in when you apply them,
   not when they arrived.
6. **The driver token is a password.** It travels in the WebSocket query
   string, so it lands in access logs and proxy logs; it is scoped to one
   session and dies with it. Never log it, never put it in a URL you show a
   player. The same goes for a driver key (`kpk_…`), which is longer-lived.

## Controller layout

The player phone lays controls out itself — drivers describe *what* controls
exist, never where they go. A pure engine
(`packages/phone/src/layout-utils.ts`, unit-tested for bounds and
overlaps down to 568×320) assigns thumb zones: joysticks go bottom-left, then
bottom-right, then small upper corners; the first four buttons form a diamond
under the right thumb (slot order bottom/right/left/top — ordering buttons
`a, b, x, y` yields the console convention), the next four become shoulder
pills along the top edge, the rest a small aux row top-center. Sizes scale
with the viewport. **Array order is the importance signal**: put a schema's
most-used controls first. Joystick modes render distinctly in their slot:
`"x"`/`"y"` as pill tracks along their axis, `"dpad"` as a rounded square
with four arrows (visibly discrete — no fine-tune values), `"relative"` as a
square pad (see "Joystick modes"). A `touchpad` is placed like a joystick
(same slots and zones, drawn 1.3× a stick's size, at its declared aspect —
see "Touchpad"). Buttons are circles (pills on the shoulder / aux rows);
`"shape": "rect"` squares off the corners of the same box and changes
nothing else. Schemas with ≥2 joysticks/touchpads or >4 buttons
require landscape (the phone renders them sideways whatever the OS viewport is —
see "Owning the orientation" below); smaller schemas get a one-handed
portrait layout (stick bottom-center, buttons above). More than 4 joysticks
is degenerate: still rendered, but shrunken — treat it as a driver bug.

**Layout hints** (["Thumb Zones"][thumb-zones] option B) let a driver state
intent without pixel control, all optional and purely additive — unhinted
controls keep flowing through the array-order heuristics above, and the
phone still owns every position and pixel size, so a hint can never push a
control off-screen or onto another one:

- Per-control `zone`: `"left"` / `"right"` claim that thumb — the bottom
  corner for a joystick, a diamond cluster for buttons (a diamond holds 4;
  further buttons on that side spill to its shoulder row, and a second
  same-side joystick takes the small upper corner, then the center overflow
  row). `"shoulder-left"` / `"shoulder-right"` are the top-edge pills,
  `"aux"` the small top-center row for rarely-used controls (pause, menu).
- Per-control `size`: `"small" | "medium" | "large"` — visual weight
  relative to the zone's default, never pixels.
- Per-schema `orientation`: `"landscape"` demands landscape regardless of
  control count; `"portrait"` declares a one-handed portrait controller
  (zones other than `aux` describe two-handed landscape and are ignored
  one-handed); `"auto"` (default) keeps the control-count heuristic. The
  phone owns the orientation either way (next section): there is no rotate
  prompt any more.

The `Tank`, `Xbox` and `Brawler` presets in the admin debug view use hints
and double as the hint playground.

The engine's output is deliberately only a **first draft**. Hints steer it,
but no heuristic fits every hand and every phone, and hyper-optimizing it is
not the plan: the player edits the draft (next section) — unless the driver
positions the controls itself, below.

### Exact positions

Some games need the controls where the game says, not where a heuristic or
a player puts them — an arcade panel mirrored on the phone, a layout that
matches on-screen art, an emulated device. For those, each button and
joystick takes optional **`x`** and **`y`**: the control's center as a
percentage (0–100) of the controller box's width and height, measured from
the top-left. They are exact (`applyDriverPositions` in `layout-utils.ts`,
run after the draft): the only adjustment is a clamp so the whole box stays
inside the viewport, so `x: 0` puts a control flush with the left edge, never
past it. The two axes are independent — an axis left out keeps the engine's
placement for that axis, so a driver can pin a row's height and let the
engine spread it.

What positions do **not** decide is size and shape: the engine still sizes
every control from its zone and `size` hint (a `"shoulder-*"` button is still
a pill, an `"aux"` one a small pill, a thumb-zone button a round primary),
and a positioned control still takes its slot in the engine's flow for the
unpositioned ones. So position everything or nothing in a schema, and lock
`orientation` — percentages are of the box the schema renders in, and a
landscape box is not a portrait one. Players can still move positioned
controls unless the config says otherwise:

**`disallowLayoutCustomization`** (config, default `false`) makes the
driver's layout final: the in-game menu and the lobby trial offer no "Edit
layout" / "Reset layout" (and so no full/relative stick swap), and any layout
a player edited in an earlier session of the same `driverAppUuid` is left in
storage but not applied. It is independent of positions — a driver may lock
a hinted or heuristic layout, or position controls and still let players
adjust them. Both are purely additive: an old driver sends neither and gets
exactly what it did before. The `Fixed` debug preset (an arcade cabinet
panel) is the playground.

### Player layout editor

Players move and resize every on-screen control themselves (unless the
driver set `disallowLayoutCustomization` — see "Exact positions" — in which
case nothing in this section is offered), from two places:
the in-game **menu** (a `Menu` button in the header; forced open — with no
close — while the driver has the game paused, since only the driver can
resume), which offers **Edit layout** and **Reset layout** next to the schema
picker and "Leave"; and the lobby's **"Try the controller"**, whose header has
its own **Edit layout** — a layout that feels wrong is usually noticed while
trying it, and before the game starts is the calm moment to fix it. Both open
the same editor on the same stored layout; the trial also plays the edited
layout, and says when edits will not be remembered (no `driverAppUuid`).

The editor renders the controller exactly as it plays, in the same slot of
the oriented surface, with a drag handle over each control: one finger drags,
two fingers pinch it bigger or smaller (the header's −/+ do the same for the
tapped control, for mouse users and tests). A one-finger drag **snaps** the
control's center to the nearest alignment line within `SNAP_PX` (10) — the
center of any other control, or the middle of the screen — and draws the
lines it caught, so a row of buttons or a pair of thumbsticks can be lined up
exactly instead of nearly. Snapping is off while pinching (the size is what
the player is aiming at then) and moves only the center, never the size, so
it can neither shrink a control below the minimum nor push one off-screen.
Every gesture is applied on the
spot; "Done" just returns to the game. Holding a finger still on a `"full"`
or `"relative"` stick (`LONG_PRESS_MS`) swaps it between those two modes —
fixed center versus the thumb's landing point is a matter of feel the driver
cannot decide, and both send `{x, y}`, so the driver never sees the
difference; modes that change the wire shape (`"x"`, `"y"`, `"dpad"`) stay as
declared. Reset drops the edits and the engine's draft is back.

What is stored (`layout-override.ts`, pure and unit-tested; `useLayoutOverride.ts`
owns the storage): per (schema id, layout mode — landscape and one-hand are
edited apart) a map of stick id → swapped mode (only departures from the
schema) and a map of control id → box, with the center as fractions of the
controller box's width/height and the size as a fraction of its shorter side,
so an edit made in a browser tab fits the home-screen app's slightly
different box and a stick stays a circle. Only edited controls override the
engine; the others keep flowing through it, so a driver that adds a control
in an update gets it placed automatically among the player's edits. Every
stored box is clamped into the viewport when applied (min `MIN_CONTROL_SIZE`
36 px, never off-screen), so a stale or garbage entry cannot hide a control;
entries for control ids the schema no longer has are ignored.

Where it is stored depends on the driver: with `config.driverAppUuid` (a
UUID the driver generates once and sends on every setup — the game's
identity) edits live in localStorage under
`kapula:layout:{driverAppUuid}:{schemaId}:{mode}` and come back in every
later session of that game. Without it there is nothing safe to file them
under (a schema id alone would make unrelated games share a layout), so edits
are kept in memory while the session screen is mounted and the menu says so.
The debug presets ship a fixed `DEBUG_DRIVER_APP_UUID`. Nothing of this
reaches the driver: input frames are identical whatever the controls look
like.

A `gyro` control is hardware, not layout: it occupies no thumb zone and never
affects `needsLandscape` or where anything else goes. Its only on-screen
presence is a chip on the top edge — live tilt taps re-center the neutral
pose (auto-calibrated from the first pair of consecutive readings that
physically agree, since some Android browsers fire the first event before
the sensor settles), and on iOS the chip is also
where motion access is requested when the player lands in a gyro schema
without it (`DeviceOrientationEvent.requestPermission` needs a user gesture
once per page load). Schemas containing a gyro control show a "⟲ tilt" badge
in the schema picker and are disabled there when the device has no usable
sensor (probe timeout) or motion access is denied — drivers offering gyro
schemas should therefore always include a gyro-free fallback schema. The
access state machine lives in `useGyro.ts`, the pure tilt math (screen-angle
remapping, neutral deltas, deadzone) in `gyro-utils.ts`.

The tilt math never differences the raw euler angles: the deviceorientation
representation is degenerate near the upright pose (gamma is clamped to
±90°, so the browser snaps between two representations of one orientation
when the screen crosses vertical, and gamma's sensitivity has a 1/cos(beta)
pole). Each reading is instead converted to the device-frame gravity vector
— continuous in every pose — from which screen-frame pitch (atan2, full
±180°) and roll (asin of the gravity component along screen-x, ±90°) are
taken relative to the neutral. Roll is boosted by the neutral pitch's
cos-shortfall (capped at the 70° level) so steering feel stays
pitch-independent at held-in-hands angles. One honest physical limit
remains: with the screen exactly vertical, left/right twist is a rotation
about gravity and cannot be sensed without yaw — steering authority fades
smoothly near fully-upright instead of turning into amplified noise. Unit
tests drive the math with rotation matrices converted to spec-compliant
euler readings (including the representation snap), not synthetic deltas.

### Owning the orientation

The controller decides which way it is held and never lets the OS re-lay it
out mid-game. The problem it solves had three parts: a tilt past the
auto-rotate threshold rotated the browser, which re-laid-out an unlocked
schema (landscape ↔ one-hand) and replaced a landscape-locked one with the
rotate prompt while the player was steering; the natural defence, the OS
rotation lock, is portrait-only on iPhones, so a landscape schema became a
permanent prompt; and iOS neither honours a manifest `orientation` nor
implements `screen.orientation.lock()`.

`OrientedSurface.tsx` (the in-game screen in `PlayerSession`, the lobby's
trial controller, the help page's demo) owns it, with the pure rules in
`orientation-utils.ts`:

- The *content angle* is device-relative (how far the content is rotated
  from the device's natural orientation, `screen.orientation.angle`'s
  convention: 90 = device top edge on the content's left, the usual
  notch-left landscape hold = CSS `rotate(90deg)` on portrait content). It
  is decided when the surface mounts — the schema's lock, else the way the
  phone is held right now; when the OS is already in the wanted orientation
  its angle is adopted, otherwise the content is rotated into it (landscape:
  the direction the player last used, remembered in localStorage).
- The *synthetic rotation* is content angle minus the OS's angle: the CSS
  transform applied to a box with swapped sides, centered in the physical
  viewport. When the OS flips the viewport mid-tilt the synthetic rotation
  changes by the opposite amount and nothing moves on screen. Within the
  same orientation the OS's angle is adopted (a player who turns the phone
  around gets upright content); across orientations the content angle
  stands. So a portrait-locked iPhone plays landscape schemas by being held
  sideways.
- Everything on the surface rotates together — header, controller, pause
  overlay — and the safe-area insets are rotated with it (`useSafeAreaInsets`
  reads env() off a probe element; `rotateInsets` moves the notch to the
  content edge it physically lies along), so nothing inside the surface uses
  env() itself.
- Touch controls map pointer movement back through the rotation (and the
  demo's scale): `pointerDeltaInFrame` in `pointer-utils.ts`, used by
  `Joystick` and `Dpad`. The gyro takes the content angle as its screen
  angle, so steering stays steering.
- A "⟳ Rotate" chip beside the sensor chips cycles both landscape holds and
  upright portrait as the lock allows (hidden when there is one way only).
  Switching schemas re-decides the angle if the new lock disallows the
  current one.
- On Android Chrome installed or fullscreen, `screen.orientation.lock()` is
  also called for the frozen orientation (and unlocked on unmount) so the
  OS rotation animation never plays; it rejects everywhere else and is
  never relied on. The manifest carries no `orientation` on purpose — it
  would lock the lobby and help pages too, and iOS ignores it anyway.

The help page tells players to lock rotation on their phone while playing;
with the surface owning orientation, a portrait-only lock is fine.

### Raw motion stream

A `motion` control (at most one per schema, may sit beside a `gyro`) streams
the inertial sensors uncalibrated for drivers that do their own motion
processing — emulators above all: Dolphin reconstructs a Wii Remote's
accelerometer and MotionPlus from exactly this feed (via a DSU / cemuhook
bridge), including shakes, swings and gyro pointing, none of which the
calibrated, dead-zoned, clamped, screen-remapped, 30 fps tilt joystick can
carry. Everything that makes `gyro` easy for a game driver is exactly what
an emulator must not have, hence two control types rather than one.

Samples ride in their own `motion` message — a stream, not state: no seq,
nothing latest-wins, relayed while in_progress only, sharing the player's
input rate window (batches of 3 at ~60 Hz = ~20 messages/s next to 30 input
frames/s). Each sample is `[t, ax, ay, az, gx, gy, gz]`: phone-monotonic ms,
acceleration including gravity in g as the reaction force (flat and still =
`[0, 0, +1]`), angular rate in deg/s, all in the W3C device frame — never the
screen's; the driver declares the hold (Wii Remote: portrait, top edge at
the TV, so forward = +y, up = +z). iOS Safari has always reported
accelerationIncludingGravity with the sign inverted, so `motion-utils.ts`
measures the sign instead of sniffing: the first quasi-static samples are
compared with the orientation-derived gravity direction and held back
(briefly, `MOTION_SIGN_TIMEOUT_MS`) until it settles, so a driver never sees
the sign flip mid-stream. `useMotionStream.ts` owns the devicemotion
subscription and batching; access is the same permission gate and probe as
tilt (`useGyro.ts` asks the DeviceMotionEvent gate in the same tap). The
admin debug view's "Wii" preset is the reference schema; its card shows the
newest sample and the sample rate.

### Raw touch

A `raw` control makes the controller box's background one multitouch
surface and reports every finger on it: `[{id, x, y}, …]` in the ordinary
input frames (`[]` when nothing touches). For drivers that interpret touch
themselves — gestures, tapping on a mirrored screen (with a background
image).

- `x` / `y` are the finger's position in the controller box, 0–1 from its
  left / top edge (y down), rounded to 3 decimals, in the content frame of
  the oriented surface (pointer positions go through `pointerDeltaInFrame`
  like the sticks). Each finger's pointer is captured, so a finger dragged
  off the box keeps reporting, clamped to the edge, until it lifts.
- `id` is the finger's slot, 0–9 (`KAPULA_RAW_MAX_TOUCHES`), stable from
  touch-down to lift-off; a new finger takes the lowest free slot, so ids
  are small and reused. An 11th finger is ignored until one lifts.
- Touch-downs and lifts flush immediately (edges, like buttons); movement
  is coalesced at ~60 fps — any schema with a `raw` or `touchpad` control
  uses the faster throttle (`POINTER_THROTTLE_MS` in `useInputSender.ts`),
  other schemas keep ~30 fps.
- It is the background, not a slot: the layout engine places nothing for
  it, and `Controller` renders `RawTouchSurface` over the whole box *under*
  the laid-out controls. A finger that lands on a button, stick or touchpad
  belongs to that control until it lifts (pointer capture) and is never
  reported as raw; a finger that lands anywhere else is raw, even if it
  then slides over a control. Any other controls may share the schema
  (until 2026-09-24 only a `gyro` could — relaxing that was additive); at
  most one `raw` per schema (`controlSchemaSchema`). "Edit layout" is
  offered when something besides the raw surface is laid out
  (`canCustomizeLayout`). Orientation follows the usual rules — lock it
  when the driver's mapping depends on it.
- The pure parts (slot allocation, clamped/rounded positions, the sorted
  wire value) are in `raw-touch-utils.ts`, unit-tested. The array is one
  more member of `kapulaInputValueSchema`; a driver only meets it after
  declaring a `raw` control, so existing drivers are untouched.

### Text input

A `text` control lets a player type on their own keyboard — the phone's
on-screen keyboard, or a real one on a laptop — for the moments a game wants
words: a party-game answer, a name, a chat line, a URL for a remote-controlled
PC.

- On the controller it is a button (`⌨ label`), laid out, hinted (`zone`,
  `size`, `x` / `y`, `shape`) and editable exactly like one. Tapping it opens
  a field along the top of the controller box and focuses it inside the tap
  (`flushSync` then `focus()` in `Controller`) — iOS raises the keyboard only
  for a focus that happens in a user gesture, so a driver can never pop the
  keyboard by itself. The keyboard may cover controls below; nothing is
  re-laid out around it.
- **Submit only.** Send (or Enter) delivers the whole text as one player
  message, `{type:"text", controlId, text}`, relayed to the driver as
  `{type:"text", playerId, controlId, text}`; the field clears and stays
  open for the next answer until ✕ (or Escape). Empty text is not sent by
  the phone. Nothing is sent while typing — no keystrokes, no key codes, so
  autocorrect, swipe typing and IME composition all just work.
- It is an event, not state: never part of the coalesced input frames (a
  merged-away frame would lose words), no seq, every message relayed in
  order. Like `motion` it is relayed only in `in_progress`, to the driver
  only, and shares the player's input rate window.
- `maxLength` (1–1000, default 1000 = `KAPULA_TEXT_MAX_LENGTH`) caps the
  field on the phone; the server drops longer messages.
- Keys a phone keyboard lacks (Enter, Backspace, Esc, arrows, modifiers for a
  remote-controlled PC) are ordinary buttons in the schema, mapped by the
  driver. A live keystroke stream is a separate, later feature (see
  BACKLOG.md).
- Known limitation: when the phone renders a landscape controller sideways
  (see "Owning the orientation"), the OS keyboard still opens in the device's
  own orientation.

### Touchpad

A `touchpad` control is the raw surface as one laid-out control among
others — the remote-control mouse is a touchpad, a `"y"` scroll slider and
two `"rect"` buttons. It reports exactly what `raw` does, `[{id, x, y}, …]`,
with `x` / `y` 0–1 inside the pad and slot ids per pad, and the phone
computes nothing from them: deltas, taps, two-finger scroll and
acceleration are the driver's. Absolute positions are also what makes the
value loss-tolerant — a dropped or coalesced frame loses a sample of the
path, never motion.

- `aspect` (width / height, 0.25–4, default 1) is the pad's real shape. The
  engine places the pad in a stick slot (zones, `size`, `x` / `y` work as
  for joysticks) at 1.3× a stick's size, capping the width so it fits and
  shrinking the height with it, and a player's pinch / ± resize in the
  layout editor is uniform — so the driver can always turn positions into
  isotropic motion (`dx * aspect` vs `dy`).
- `label` (optional) is drawn faintly in the pad's middle.
- It is rendered by the same `RawTouchSurface` as `raw` (framed, inside the
  control's box), so the finger rules above — slots, capture, clamping at
  the edge, edges flushing immediately, ~60 fps movement — are identical.

The full design exploration (options considered, mockups, and the follow-ups
below) is in the ["Thumb Zones" artifact][thumb-zones].

[thumb-zones]: https://claude.ai/code/artifact/abac20f9-ee3c-4ca8-b130-b903414a433f

## Phone web app (home screen / standalone)

Players are told to pin the controller to the home screen, so iOS standalone
mode is a first-class target, not an accident: `frontend/src/apps/gamepad/
index.html` carries the `apple-mobile-web-app-*` meta, a `theme-color`, and
links `public/manifest.webmanifest` (`display: standalone`, `scope: /`,
`start_url: /gamepad/` — the info app's pattern, so the pinned app stays
same-origin across apps on the bare domain) plus the icons in `public/icons/`
(`icon.svg` is the source; the PNGs are renders of it). Files under an app's
`public/` dir are copied verbatim into `dist/{appId}/` by Vite and served at
`/{appId}/…` on every host; the dev server falls back to them too
(`mpaDevPlugin` in `vite.config.ts`).

Rotation is handled by the app, not the platform ("Owning the orientation"
above): the manifest deliberately has no `orientation`, and players are
advised to lock rotation on the phone while playing — iOS's portrait-only
lock included, since the in-game surface rotates its own content.

**Touches landing offset from the buttons** was the first standalone bug, and
the reason the layer exists. The session screen is a stack of `position:
fixed` layers, and two things split where they paint from where touches
resolve: iOS scrolls the window to reveal the lobby's name field and leaves
that scroll behind after the keyboard is dismissed; and Safari ignores
`user-scalable=no`, so a stray pinch on the lobby carries a zoomed visual
viewport into the game. `useViewportGuard.ts` removes both:
`useFixedLayerScrollGuard` (mounted by `PlayerSession`) scrolls the window
back to the origin on mount, after every `focusout`, and on every
window/visualViewport scroll or resize while no text field is focused (while
the keyboard is up iOS scrolls on purpose); `useNoPinchZoom` (mounted by
`KapulaApp`) swallows Safari's `gesturestart`/`gesturechange` and
multi-touch `touchmove`, with `touch-action: pan-x pan-y` on `html` for the
other browsers. Remote-inspect a misbehaving phone by checking
`window.scrollY` and `visualViewport.offsetTop` / `.scale` while it happens.

The viewport is `viewport-fit=cover`, so the page runs under the notch and
the home indicator. `body` padding in `index.html` keeps window-scrolling
pages (landing, help) clear of the top and sides; the fixed session layer
pads itself with `safe-area.ts` (`topBar` for headers, `edges` for the
controller box and the lobby scroller — the layout engine measures the padded
box, so a control is never placed under a notch). The status bar is
`black-translucent`: the dark ground shows through it.

## Implementation map

- `packages/protocol/src/index.ts` — protocol schemas/types (start here).
- `packages/server/src/` — the server is a host-agnostic core plus
  the monorepo's adapters, so it can be extracted into its own package (the
  Kapula plan) and embedded in a desktop app that has no database:
  - **Core** (no imports of the monorepo's `db`, `env`, `logger`, auth or
    cron): `store.ts` (the `KapulaStore` persistence contract and the
    server's own session/player/key records — start here for the data
    model), `context.ts` (`KapulaContext`: store + host auth + logger +
    `KapulaServerConfig` with its defaults), `logic.ts` (pure rules),
    `runtime.ts` (`createSessionRuntimes`: in-memory connections per
    session, single-process; snapshots; the driver-lost watchdog),
    `signaling.ts` (`createSignaling`: the WS roles), `player-api.ts`
    (`createPlayerRouter`: the phone's three JSON routes, see "Player HTTP
    API"), `memory-store.ts`
    (`createKapulaMemoryStore`: the contract in process memory with an
    injectable clock — for an embedded host and for tests), `driver-api.ts`
    (`createDriverRouter`: the driver HTTP API, `/driver/setup`,
    `/driver/create`, backgrounds), `service.ts` (`createKapulaService`:
    what the host page and the phone do over HTTP, framework-free, failing
    with `KapulaServiceError`), `server.ts` (the monorepo: `gamepad-server.ts`)
    (`createKapulaServer(deps)`: wires the above and exposes
    `httpRouter` — driver + player routes —, `attachWebSocket`, `service`,
    `runCleanup`).
  - **Monorepo adapters:** `operations.ts` (piquel SQL) behind
    `postgres-store.ts` (maps rows to records, Postgres unique violations to
    `KapulaStoreConflictError`), `instance.ts` (the one `gamepad` server
    instance: Postgres store, `gauth` cookie as host auth, env-derived
    config — mounted in `server.ts`, attached in `index.ts`), `gamepad.ts`
    (the host page's tRPC: thin wrappers over `service`), `cleanup.ts` (per-minute cron
    calling `runCleanup`: idle + driver-lost backstop).
  Migrations: `31-gamepad.sql`,
  `32-gamepad-host-player.sql`, `33-gamepad-metadata.sql`,
  `35-gamepad-driver-loss.sql`, `36-gamepad-drop-player-user.sql` (drops the
  column 32 added: host auto-join is gone), `37-gamepad-driver-keys.sql`
  (self-service driver keys), `53-gamepad-background.sql` (driver background
  images; the upload, delete and public GET live in `driver-api.ts`). Env:
  `KAPULA_DRIVER_LOST_TIMEOUT_MS`
  shortens the watchdog outside production (the e2e suite needs it).
- `frontend/src/apps/gamepad/` — the **host page** (monorepo-only):
  `KapulaApp` (wouter routes on the app's
  base path: `/` landing — always reachable, even mid-session — plus
  `/play`, `/join/:code`, `/debug`, `/help`; it mounts the
  `KapulaPlayerProvider` with the API base the backend serves on),
  `HostPanel` (hosted sessions and driver keys over tRPC), `PrivateSessions`,
  `DebugDriver` and `HelpPage` (both below).
- `packages/phone/src/` — the **player screens**, host-agnostic
  (the future Kapula phone package). They import nothing from the monorepo
  and know no server path: `config.tsx` holds `KapulaPlayerConfig`
  (`apiBase`, default `/api/kapula`), the provider/hook and
  `buildKapulaWsUrl`; `player-api.ts` is the JSON client for that base
  (`createPlayerApi` / `usePlayerApi`); `ui.tsx` the few primitives
  (Button, Card, Badge, LoadingState) styled with the `kp-*` Tailwind
  tokens, which `tailwind-preset.js` defines over the CSS variables in
  `kapula.css` (RGB triplets so opacity modifiers work; defaults = the
  monorepo palette, a host re-themes by redefining the variables).
  `tests/unit/player-boundary.spec.ts` enforces all of this. Inside:
  `JoinScreen`,
  `PlayerSession` (lobby/controller/paused; mounts the scroll guard from
  `useViewportGuard.ts` and pads with `safe-area.ts`), `Controller` +
  `Joystick` (pointer events, wake lock, input sender) with `layout-utils.ts`
  (pure layout engine incl. driver `x`/`y` positions, see "Controller
  layout"), `ControlWidget` (one
  resolved control, shared by the controller and the editor),
  `SessionMenu` (the in-game menu / pause overlay), `LayoutEditor` +
  `layout-override.ts` + `useLayoutOverride.ts` (the player layout editor:
  drag/pinch handles, the pure box math and storage — see "Player layout
  editor"), `SchemaPicker` (lobby/menu layout buttons with the gyro badge +
  gating, plus the "Real gamepad" option), `physical-gamepad-utils.ts` +
  `usePhysicalGamepad.ts` + `PhysicalGamepadPanel.tsx` (Gamepad API bridge:
  pure mapping/deadzone/diff, the poll loop, the in-game readout — see
  "Physical gamepads"), `gyro-utils.ts` (pure tilt
  math) + `useGyro.ts` (motion access state machine, deviceorientation
  subscription), `OrientedSurface.tsx` + `orientation-utils.ts` +
  `pointer-utils.ts` (the in-game surface that owns orientation, its pure
  rules, and pointer mapping through its rotation), `motion-utils.ts` +
  `useMotionStream.ts` (raw IMU stream: sign normalization, batching),
  `RawTouchSurface.tsx` + `raw-touch-utils.ts` (the `raw` control: finger
  slots and box positions), `useKapulaSocket.ts` (the reconnecting session
  socket, also used by the host page), `snapshot-utils.ts` /
  `session-messages.ts` / `debug-utils.ts` (pure helpers shared with the host
  page).
- Back in the host page: `DebugDriver` (admin debug view, below, driven by
  `player/debug-utils.ts`), `HelpPage` (`/help` — the
  public "How to use" page: player/host instructions plus the driver
  HTTP + WS docs; its content mirrors this file and
  `packages/protocol/src/index.ts`, so update it with any protocol change; it
  embeds a live `Controller` demo — one control of every kind, `send` wired
  to an on-page frame display instead of a socket, rendered at the tested
  568×320 minimum and CSS-scaled down on narrow screens).
- Tests — three npm scripts: `npm run test:unit` (unit only),
  `npm run test:e2e` (e2e only) and `npm run test` (both, unit first).
  `tests/unit/*.spec.ts` are pure specs (logic, wire-contract
  schemas, layout geometry, layout-override box math, gyro tilt math,
  physical-gamepad mapping, frontend snapshot folding; no browser or
  servers). The **store conformance suite**
  (`packages/server/src/testing/store-conformance.ts`) is one spec of the
  `KapulaStore` contract run against every implementation: the unit project
  runs it on the memory store (`memory-store.spec.ts`, with a fake
  clock), the e2e project on the Postgres adapter
  (`the monorepo's gamepad-postgres-store.spec.ts`, reading `DATABASE_URL` from the
  environment or `backend/.env`; it creates two throwaway users and skips the
  tests that sweep every live session, since the dev database is shared).
  A store rule changes in three places: the contract's doc comment, the
  suite, and each store. The e2e suites need the DB up and reuse running dev servers or
  start their own (`PW_FRONTEND_URL` points a run at an alternative stack,
  e.g. a freshly booted backend on a spare port, since the backend serves
  `/api` itself): `tests/e2e/browser.spec.ts` (full flow through the real frontend
  with a scripted driver) and `tests/e2e/ws.spec.ts` (protocol-level:
  raw WebSockets for all three roles — close codes, snapshots, 4010
  takeover, state gates, input relay + rate limits, driver-loss auto-pause,
  malformed/oversized frames, driver-setup rate limiting, roster sessions;
  every server frame is validated against `kapulaServerMessageSchema`,
  and the setup-code path is exercised for both the default and an explicit
  `protocolVersion`). e2e runs with one worker: the spec files share one dev
  stack and the one-hosted-session-per-user rule. The driver-setup rate limit is
  keyed per caller outside production — the dev-only
  `x-kapula-ratelimit-key` header, which the helpers (`driverSetup`,
  `TestDriver.setup`) fill with a fresh bucket per call — so the black-box
  429 test fills one fixed bucket of its own and always runs, draining
  nothing. The limiter's window logic is separately unit-tested with a fake
  clock (`createRateLimiter` in `logic.ts`). The driver-lost watchdog test
  runs only when
  the backend under test was booted with a short
  `KAPULA_DRIVER_LOST_TIMEOUT_MS` and the same value is in the test
  process's environment (it is skipped otherwise).

## Admin debug driver (`/gamepad/debug`)

A stand-in for an external driver, for developing without a real game
running. Visible only to admins (`user.isAdmin`, checked in `KapulaApp`); it
deliberately uses the exact same public driver surface a real game uses
(`POST /api/kapula/driver/setup` + the driver WebSocket role), so there is
no debug-only backend code and using it exercises the production paths.

What it does:

- Claims a session by setup code with an editable JSON config (Generic, Tank,
  Xbox, Racer, Brawler, Aim, Tilt, Wii, Multi, Fixed and Roster presets —
  Xbox is a deliberately oversized 15-control layout for stress-testing the
  controller UI; Racer has one joystick of every single-value mode: x-only,
  y-only and dpad; Aim pairs a walking stick with a `relative` aiming pad;
  Tilt and Wii cover the two sensor control types; Fixed pins every control
  with `x`/`y` and sets `disallowLayoutCustomization`; Touch is the `raw`
  surface, alone and with tilt; Roster is the recovery path). It
  prefills the admin's own pending
  session's setup code and
  can create a session right there, so the whole loop works from one page.
- Shows the live session: state, join code (+ copy link), per-player cards
  with name/color/ready/connected/schema, the latest input frame (button
  pressed-state with a `×N` press counter, joystick axes with a mini
  visualization), input `seq` and a frames-per-second readout for verifying
  the ~30fps client throttle.
- Driver commands: start / pause / resume / end, a per-player Vibrate button
  and schema dropdown (the `set_schema` push) and a broadcast JSON payload
  sender (the `message` relay), and a background image uploader (file +
  `fit`, and Remove) that calls the public background endpoint with the
  driver token. A `raw` control's card draws the fingers on a miniature box.
- An event log of protocol messages (input frames and pongs excluded).

Driver credentials persist in localStorage (`gamepad:debug-driver`) so the
page survives reloads; "Forget session" drops the token (the session then
pauses until ended by the host or cleaned up). On the debug route the page
acts purely as the driver: it never adopts the host player credential that
driver setup creates (the normal host-drops-into-lobby convenience), so
opening the debug view never claims the player slot or opens the player
WebSocket. Pure state-folding lives in
`packages/phone/src/debug-utils.ts` (unit-tested); the e2e suite has
a full scenario driving a session from the debug view.

## Roadmap

`BACKLOG.md` next to this file is the ordered, self-contained work list:
what is done, what is next, and why. Ideas that are not in it yet belong
there rather than here.

## Design decisions worth remembering

- Input over TCP WS means head-of-line blocking on loss; small frames + the
  latest-seq-wins rule mitigate it until WebRTC lands.
- Elapsed time is measured in SQL, never from a row's Date: the session
  timestamps are naive `timestamp` columns written by the database in UTC,
  and `pg` parses naive timestamps in the process's local zone. On a
  developer machine that made `driver_disconnected_at.getTime()` hours stale
  and the resumed driver-lost timer fired at once (`getDriverAwayMs`).
- Lost sessions are solved by **abandoning fast and recreating fast**, not by
  keep-alive logic: a driver away for 3 minutes ends the session outright
  (no lingering "paused" ghosts on phones or the host page), and the roster
  makes the replacement session a one-tap rejoin for every player. Keeping a
  session alive across a lost driver would need liveness heuristics, token
  hand-over and stale-state reconciliation — all avoided.
- "Hard to close accidentally" is solved by **recovery, not prevention**:
  wake lock + no-overscroll + no-zoom viewport reduce accidents, and the
  localStorage token makes an accidental close a sub-second rejoin.
  `beforeunload` prompts were deliberately skipped (unreliable on iOS).
- The host cannot start the game: the driver may not have finished loading a
  level, so "everyone ready" is information for the driver, which starts.
- Duplicate colors were originally allowed in the spec; uniqueness for both
  name and color was chosen later, hence `colors.length >= maxPlayers`.
- Layout hints are declarative intent (zones and weights), never geometry:
  ["Thumb Zones"][thumb-zones] option C (driver-authored grids) was rejected
  because drivers design on screens they never test. The vocabulary is wire
  protocol forever — grow it reluctantly. (The proposal's `variant: "dpad"`
  hint shipped early as the functional joystick `mode`.) The one geometric
  exception came later, on request: percentage `x` / `y` positions (see
  "Exact positions"), for games whose layout *is* the game — kept exact
  (clamped, never re-flowed), per axis, and without sizes, so the hint
  vocabulary still owns shape and the engine still owns fitting. The
  companion `disallowLayoutCustomization` flag is what makes them mean
  something on a phone whose player could otherwise drag them anywhere.
- Physical gamepads are a **fixed control set under a reserved schema id**,
  not a per-schema binding table: the driver opts in with one flag and
  reads well-known ids, and the phone never has to guess which of a
  schema's controls a trigger should be. Analog triggers forced the one new
  value shape (a bare number); everything else reuses joystick and dpad
  shapes so existing driver code reads sticks and the hat unchanged.
- The background image travels over **HTTP, not the WebSocket**: images are
  megabytes and the socket's limits are 8 KB per message and 64 KB per frame
  on purpose. It is stored in the database rather than in the runtime so it
  survives a backend restart like the rest of the session, and served by a
  per-upload key so phones can cache it forever.
- `raw` is a **control type with an exclusivity rule**, not a new schema
  kind: the schema shape stays the same, the value is one more input shape,
  and "only gyro beside it" is a validation rule — all additive. Starting
  strict (not even `motion`) is deliberate: relaxing the rule later is
  additive, tightening it would not be.
- Gyro streams as a virtual joystick (`{x,y}`) instead of a new value shape,
  so adding it was a pure schema addition — no protocol bump, no driver
  changes. Only the gravity-referenced tilt axes (beta/gamma) are used: yaw
  needs the compass, drifts, and was cut on purpose; revisit only with a
  proper sensor-fusion story.
