import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import {
  KAPULA_CODE_ALPHABET,
  KAPULA_PROTOCOL_VERSION,
  PHYSICAL_GAMEPAD_SCHEMA_ID,
} from "@kapula/protocol";
import { HOST_URL } from "../../playwright.config";
import {
  WsClient,
  allClients,
  createHostSession,
  devLogin,
  driverCreate,
  driverSetup,
  getJoinInfo,
  getPlayerStatus,
  hostCall,
  joinSession,
  sleep,
  uniqueEmail,
} from "./ws-utils";


/**
 * Protocol-level WebSocket tests: no browser, just the documented driver HTTP
 * API, the host and player JSON APIs and raw WebSocket connections for all
 * three roles. Complements browser.spec.ts, which drives the real frontend.
 *
 * NOTE: /api/kapula/driver/setup is rate limited (10/min per bucket). The
 * driverSetup helper scopes every call to its own dev-only bucket (the
 * host honors an x-kapula-ratelimit-key header outside production), so
 * spec files and repeat runs against a live backend never throttle each
 * other; the rate-limit test fills one fixed bucket on purpose.
 */

const newContext = () =>
  playwrightRequest.newContext({
    baseURL: HOST_URL,
    ignoreHTTPSErrors: true,
  });

const CODE_PATTERN = new RegExp(`^[${KAPULA_CODE_ALPHABET}]{6}$`);

test.describe("connection validation and close codes", () => {
  test("unknown or missing role closes with 4000", async () => {
    const noRole = await WsClient.open("");
    expect((await noRole.waitForClose()).code).toBe(4000);
    const badRole = await WsClient.open("?role=banana");
    expect((await badRole.waitForClose()).code).toBe(4000);
  });

  test("driver: missing token 4000, unknown token 4004", async () => {
    const missing = await WsClient.open("?role=driver");
    expect((await missing.waitForClose()).code).toBe(4000);
    const unknown = await WsClient.open("?role=driver&token=deadbeef");
    expect((await unknown.waitForClose()).code).toBe(4004);
  });

  test("player: missing token 4000, unknown token 4004", async () => {
    const missing = await WsClient.open("?role=player");
    expect((await missing.waitForClose()).code).toBe(4000);
    const unknown = await WsClient.open("?role=player&token=deadbeef");
    expect((await unknown.waitForClose()).code).toBe(4004);
  });

  test("host: auth and session ownership are enforced", async () => {
    // No cookie at all.
    const anonymous = await WsClient.open("?role=host&sessionId=1");
    expect((await anonymous.waitForClose()).code).toBe(4001);

    const ownerCtx = await newContext();
    const strangerCtx = await newContext();
    try {
      const ownerCookie = await devLogin(
        ownerCtx,
        uniqueEmail("kapula-ws-owner"),
      );
      const strangerCookie = await devLogin(
        strangerCtx,
        uniqueEmail("kapula-ws-stranger"),
      );
      const { sessionId } = await createHostSession(ownerCtx);

      // Authenticated but no sessionId.
      const noSession = await WsClient.open("?role=host", {
        headers: { Cookie: ownerCookie },
      });
      expect((await noSession.waitForClose()).code).toBe(4000);

      // A session that does not exist, and one that is not yours.
      const wrongId = await WsClient.open("?role=host&sessionId=999999999", {
        headers: { Cookie: ownerCookie },
      });
      expect((await wrongId.waitForClose()).code).toBe(4004);
      const stranger = await WsClient.open(`?role=host&sessionId=${sessionId}`, {
        headers: { Cookie: strangerCookie },
      });
      expect((await stranger.waitForClose()).code).toBe(4004);

      // A non-numeric sessionId must fail closed, not crash the server.
      const garbage = await WsClient.open("?role=host&sessionId=garbage", {
        headers: { Cookie: ownerCookie },
      });
      expect((await garbage.waitForClose()).code).toBe(4000);

      // The owner connects before the driver claims the session and sees the
      // not_initialized snapshot; the host escape hatch then ends it (4005).
      const host = await WsClient.open(`?role=host&sessionId=${sessionId}`, {
        headers: { Cookie: ownerCookie },
        label: "pre-driver host",
      });
      const snapshot = await host.waitForType("snapshot");
      expect(snapshot.snapshot).toMatchObject({
        state: "not_initialized",
        driverConnected: false,
        players: [],
      });

      const ended = await hostCall(ownerCtx, "endMySession");
      expect(ended.data).toEqual({ success: true });
      await host.waitFor(
        (m) => m.type === "state_changed" && m.state === "ended",
      );
      expect((await host.waitForClose()).code).toBe(4005);

      // Ending freed the one-active-session-per-user slot.
      const again = await createHostSession(ownerCtx);
      expect(again.setupCode).toMatch(CODE_PATTERN);
      await hostCall(ownerCtx, "endMySession");
    } finally {
      await ownerCtx.dispose();
      await strangerCtx.dispose();
    }
  });
});

test.describe.serial("full protocol flow over one session", () => {
  const COLORS = ["#FF6B6B", "#4D96FF", "#6BCB77", "#FFD93D"];
  const CONFIG = {
    game: "WS Protocol Test",
    minPlayers: 2,
    maxPlayers: 3,
    schemas: [
      {
        id: "tank",
        name: "Tank",
        controls: [
          { type: "joystick", id: "drive" },
          { type: "button", id: "fire", label: "Fire" },
        ],
      },
      {
        id: "alt",
        name: "Alt",
        controls: [{ type: "button", id: "jump", label: "Jump" }],
      },
    ],
    colors: COLORS,
    // Free-form and uninterpreted: the point of the assertion below is that
    // the list survives storage and reaches every role verbatim.
    capabilities: ["webrtc", "made-up"],
  };

  let ctx: APIRequestContext;
  let hostCookie: string;
  let sessionId: string;
  let joinCode: string;
  let driverToken: string;
  let setupBody: Awaited<ReturnType<typeof driverSetup>>["body"];
  let driver: WsClient;
  let host: WsClient;
  let p1: WsClient;
  let p2: WsClient;
  let p1Token: string;
  let p2Token: string;
  let p1Id: string;
  let p2Id: string;

  test.beforeAll(async () => {
    ctx = await newContext();
    hostCookie = await devLogin(ctx, uniqueEmail("kapula-ws-host"));
    const created = await createHostSession(ctx);
    sessionId = created.sessionId;
    const setup = await driverSetup(ctx, created.setupCode, CONFIG);
    expect(setup.status).toBe(200);
    expect(setup.body.success).toBe(true);
    setupBody = setup.body;
    joinCode = setup.body.joinCode!;
    driverToken = setup.body.driverToken!;
  });

  test.afterAll(async () => {
    for (const client of [driver, host, p1, p2]) client?.close();
    await ctx?.dispose();
  });

  test("driver setup: response fields, no owner auto-join, single-use code", async () => {
    expect(setupBody.protocolVersion).toBe(KAPULA_PROTOCOL_VERSION);
    expect(setupBody.sessionId).toBe(sessionId);
    expect(joinCode).toMatch(CODE_PATTERN);
    expect(setupBody.joinUrl).toContain(`join/${joinCode}`);
    expect(setupBody.wsPath).toBe(
      `/api/kapula/ws?role=driver&token=${driverToken}`,
    );
    // wsUrl is the same socket, absolute, so a driver never has to know the
    // base URL it was set up through.
    expect(setupBody.wsUrl).toMatch(/^wss?:\/\//);
    expect(setupBody.wsUrl!.endsWith(setupBody.wsPath!)).toBe(true);

    // Hosting and playing are separate: claiming the session must NOT join
    // the owner as a player — no roster entry, no player credential.
    const mine = await hostCall(ctx, "getMySession");
    expect(mine.data.state).toBe("waiting_for_players");
    expect(mine.data.joinCode).toBe(joinCode);
    expect(mine.data.player).toBeUndefined();

    // The join screen data: empty roster, full palette, nothing leaks tokens.
    const info = await getJoinInfo(ctx, joinCode);
    expect(info.data).toMatchObject({
      state: "waiting_for_players",
      game: "WS Protocol Test",
      maxPlayers: 3,
      playerCount: 0,
    });
    expect(info.data.availableColors).toEqual(COLORS);
    expect(info.data.schemas).toEqual([
      { id: "tank", name: "Tank" },
      { id: "alt", name: "Alt" },
    ]);
    expect(JSON.stringify(info.data)).not.toContain(driverToken);

    const unknownInfo = await getJoinInfo(ctx, "ZZZZZZ");
    expect(unknownInfo.data).toBeNull();

    // The setup code was consumed by the successful call.
    const reuse = await driverSetup(ctx, mine.data.setupCode ?? "ABC234");
    expect(reuse.status).toBe(404);
  });

  test("each role receives a full snapshot on connect", async () => {
    driver = await WsClient.open(`?role=driver&token=${driverToken}`, {
      label: "driver",
    });
    const driverSnap = await driver.waitForType("snapshot");
    expect(driverSnap.playerId).toBeUndefined();
    const snap = driverSnap.snapshot as any;
    expect(snap.state).toBe("waiting_for_players");
    expect(snap.driverConnected).toBe(true);
    expect(snap.config.schemas.map((s: any) => s.id)).toEqual(["tank", "alt"]);
    expect(snap.config.capabilities).toEqual(["webrtc", "made-up"]);
    // The owner was not auto-joined: the lobby starts empty.
    expect(snap.players).toHaveLength(0);

    host = await WsClient.open(`?role=host&sessionId=${sessionId}`, {
      headers: { Cookie: hostCookie },
      label: "host",
    });
    const hostSnap = await host.waitForType("snapshot");
    expect(hostSnap.playerId).toBeUndefined();
    expect((hostSnap.snapshot as any).driverConnected).toBe(true);

    // Joining over the player API announces the player to the already-connected roles.
    const dCursor = driver.mark();
    const hCursor = host.mark();
    const join = await joinSession(ctx, joinCode);
    expect(join.error).toBeUndefined();
    p1Id = join.data.playerId;
    p1Token = join.data.playerToken;
    const joined = await driver.waitForType("player_joined", { after: dCursor });
    expect((joined.player as any).name).toBe("Player 1");
    expect((joined.player as any).color).toBe(COLORS[0]);
    await host.waitForType("player_joined", { after: hCursor });

    p1 = await WsClient.open(`?role=player&token=${p1Token}`, { label: "p1" });
    const p1Snap = await p1.waitForType("snapshot");
    expect(p1Snap.playerId).toBe(p1Id);
    await driver.waitFor(
      (m) => m.type === "player_connected" && m.playerId === p1Id,
    );
    await host.waitFor(
      (m) => m.type === "player_connected" && m.playerId === p1Id,
    );
  });

  test("a second connection for the same identity takes the slot (4010)", async () => {
    const dCursor = driver.mark();
    const replacement = await WsClient.open(`?role=player&token=${p1Token}`, {
      label: "p1-replacement",
    });
    expect((await p1.waitForClose()).code).toBe(4010);
    await replacement.waitForType("snapshot");
    p1 = replacement;
    // The takeover must not read as the player leaving.
    await sleep(200);
    expect(
      driver.countSince(
        dCursor,
        (m) => m.type === "player_disconnected" && m.playerId === p1Id,
      ),
    ).toBe(0);

    const oldDriver = driver;
    const pCursor = p1.mark();
    const newDriver = await WsClient.open(`?role=driver&token=${driverToken}`, {
      label: "driver-replacement",
    });
    expect((await oldDriver.waitForClose()).code).toBe(4010);
    await newDriver.waitForType("snapshot");
    driver = newDriver;
    await p1.waitForType("driver_connected", { after: pCursor });
  });

  test("lobby: profile, ready and schema rules", async () => {
    // Rename to a free name. (Broadcast waits use content predicates: other
    // broadcasts for the same socket can still be in flight.)
    let cursor = p1.mark();
    p1.send({ type: "update_profile", name: "Alpha" });
    const updated = await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).name === "Alpha",
      { after: cursor },
    );
    expect((updated.player as any).color).toBe(COLORS[0]);
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).name === "Alpha",
    );

    // A second player provides the taken name/color to collide with. With p1
    // renamed to Alpha, the default "Player 1" slot is free again.
    const tempJoin = await joinSession(ctx, joinCode);
    expect(tempJoin.error).toBeUndefined();
    const temp = await WsClient.open(
      `?role=player&token=${tempJoin.data.playerToken}`,
      { label: "temp" },
    );
    const tempSnap = await temp.waitForType("snapshot");
    const tempInfo = (tempSnap.snapshot as any).players.find(
      (p: any) => p.playerId === tempJoin.data.playerId,
    );
    expect(tempInfo.name).toBe("Player 1");
    expect(tempInfo.color).toBe(COLORS[1]);

    // Names are unique case-insensitively.
    cursor = p1.mark();
    p1.send({ type: "update_profile", name: "PLAYER 1" });
    let error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("profile_taken");
    expect(String(error.message)).toContain("name");

    // Colors must come from the palette and be free.
    cursor = p1.mark();
    p1.send({ type: "update_profile", color: "#010203" });
    error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("profile_taken");
    expect(String(error.message)).toContain("palette");

    cursor = p1.mark();
    p1.send({ type: "update_profile", color: COLORS[1] });
    error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("profile_taken");
    expect(String(error.message)).toContain("color");

    // Leaving from the lobby is an orderly exit: normal close, player_left
    // broadcast to the other roles, and the name/color slot freed.
    cursor = p1.mark();
    const dCursor = driver.mark();
    temp.send({ type: "leave" });
    expect((await temp.waitForClose()).code).toBe(1000);
    for (const [client, after] of [
      [p1, cursor],
      [driver, dCursor],
    ] as const) {
      await client.waitFor(
        (m) => m.type === "player_left" && m.playerId === tempJoin.data.playerId,
        { after },
      );
    }
    const infoAfterLeave = await getJoinInfo(ctx, joinCode);
    expect(infoAfterLeave.data.playerCount).toBe(1);
    expect(infoAfterLeave.data.availableColors).toContain(COLORS[1]);

    // A name the message schema rejects is dropped without any response.
    p1.send({ type: "update_profile", name: "🔥🔥" });
    await p1.expectNoResponse((m) => m.type === "error");

    // Ready toggles broadcast to everyone.
    cursor = host.mark();
    p1.send({ type: "set_ready", ready: true });
    await host.waitFor(
      (m) =>
        m.type === "player_updated" &&
        (m.player as any).playerId === p1Id &&
        (m.player as any).ready === true,
      { after: cursor },
    );

    // Schema selection: valid id sticks, unknown id errors.
    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "alt" });
    await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).schemaId === "alt",
      { after: cursor },
    );
    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "does-not-exist" });
    error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("unknown_schema");
    // The reserved real-gamepad id is unknown unless the driver allowed it
    // (this config did not; the roster suite covers the allowed case).
    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: PHYSICAL_GAMEPAD_SCHEMA_ID });
    error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("unknown_schema");
    p1.send({ type: "select_schema", schemaId: "tank" });
    await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).schemaId === "tank",
    );
  });

  test("malformed, unknown and oversized frames never take the session down", async () => {
    // Garbage and schema-invalid messages are ignored without a response.
    p1.sendRaw("this is not json");
    p1.sendRaw('{"type":"bogus"}');
    p1.sendRaw('{"type":"set_ready"}'); // missing field
    p1.send({ type: "input", seq: -1, controls: {} }); // negative seq
    p1.send({ type: "input", seq: 1, controls: { drive: { x: 2, y: 0 } } }); // out of range
    p1.send({ type: "input", seq: 1, controls: { BadId: true } }); // non-kebab id
    await p1.expectNoResponse((m) => m.type === "error");

    // Between 8 KB and the ws maxPayload: dropped silently, socket stays up.
    const cursor = p1.mark();
    p1.sendRaw(`{"type":"ping","pad":"${"a".repeat(9000)}"}`);
    await sleep(300);
    expect(p1.countSince(cursor, (m) => m.type === "pong")).toBe(0);
    await p1.settle();

    // Above maxPayload (64 KB) ws itself closes the connection (1009) —
    // and the server must survive it (unhandled socket errors used to be
    // process-fatal).
    p1.sendRaw("x".repeat(100_000));
    expect((await p1.waitForClose()).code).toBe(1009);
    p1 = await WsClient.open(`?role=player&token=${p1Token}`, {
      label: "p1-after-1009",
    });
    await p1.waitForType("snapshot");
    await driver.settle();
  });

  test("join capacity and start gating", async () => {
    // Input in the lobby is not relayed.
    const dCursor = driver.mark();
    p1.send({ type: "input", seq: 10, controls: { fire: true } });
    await p1.settle();
    await sleep(200);
    expect(driver.countSince(dCursor, (m) => m.type === "input")).toBe(0);

    // Only p1 is connected (and ready); minPlayers is 2.
    let cursor = driver.mark();
    driver.send({ type: "start" });
    let error = await driver.waitForType("error", { after: cursor });
    expect(error.code).toBe("cannot_start");
    expect(String(error.message)).toContain("at least 2");

    const join = await joinSession(ctx, joinCode);
    expect(join.error).toBeUndefined();
    p2Id = join.data.playerId;
    p2Token = join.data.playerToken;
    p2 = await WsClient.open(`?role=player&token=${p2Token}`, { label: "p2" });
    const p2Snap = await p2.waitForType("snapshot");
    expect((p2Snap.snapshot as any).players).toHaveLength(2);

    // A third join (never connected) fills the roster to maxPlayers.
    const join3 = await joinSession(ctx, joinCode);
    expect(join3.error).toBeUndefined();
    const full = await joinSession(ctx, joinCode);
    expect(full.error?.data?.code).toBe("CONFLICT");
    expect(full.error?.message).toContain("full");

    // p2 is connected but not ready.
    cursor = driver.mark();
    driver.send({ type: "start" });
    error = await driver.waitForType("error", { after: cursor });
    expect(error.code).toBe("cannot_start");
    expect(String(error.message)).toContain("ready");

    p2.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true &&
        (m.player as any).playerId === p2Id,
    );

    // The disconnected p3 is ignored; the game starts everywhere.
    const cursors = [driver, host, p1, p2].map((c) => c.mark());
    driver.send({ type: "start" });
    for (const [i, client] of [driver, host, p1, p2].entries()) {
      const change = await client.waitFor(
        (m) => m.type === "state_changed" && m.state === "in_progress",
        { after: cursors[i] },
      );
      expect(change.reason).toBe("driver_command");
    }
  });

  test("input relays to the driver only, with playerId and seq intact", async () => {
    const hCursor = host.mark();
    const p2Cursor = p2.mark();

    p1.send({
      type: "input",
      seq: 1,
      controls: { drive: { x: 0.5, y: -1 }, fire: true },
    });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id,
    );
    expect(frame.seq).toBe(1);
    expect(frame.controls).toEqual({ drive: { x: 0.5, y: -1 }, fire: true });

    // Boundary axes are legal; a second player is distinguished by playerId.
    p2.send({ type: "input", seq: 7, controls: { drive: { x: -1, y: 1 } } });
    const frame2 = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p2Id,
    );
    expect(frame2.seq).toBe(7);

    // Single-axis and dpad joystick values relay verbatim.
    p1.send({
      type: "input",
      seq: 2,
      controls: { steer: { x: 0.25 }, throttle: { y: -0.5 }, look: "ul" },
    });
    const frame3 = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id && (m.seq as number) > (frame.seq as number),
    );
    expect(frame3.controls).toEqual({
      steer: { x: 0.25 },
      throttle: { y: -0.5 },
      look: "ul",
    });

    // Neither the host nor the other players ever see input frames.
    await sleep(200);
    expect(host.countSince(hCursor, (m) => m.type === "input")).toBe(0);
    expect(p2.countSince(p2Cursor, (m) => m.type === "input")).toBe(0);
  });

  test("motion batches relay to the driver verbatim, in order, driver only", async () => {
    const hCursor = host.mark();
    const p2Cursor = p2.mark();
    const dCursor = driver.mark();

    const first = [[10, 0, 0, 1, 0, 0, 0], [26.7, 0.01, -0.02, 0.98, 12.5, -3, 0.5]];
    const second = [[43.3, 0.5, 0.5, 0.7, 250, -250, 90]];
    p1.send({ type: "motion", samples: first });
    p1.send({ type: "motion", samples: second });
    const batch1 = await driver.waitFor(
      (m) => m.type === "motion" && m.playerId === p1Id,
      { after: dCursor },
    );
    expect(batch1.samples).toEqual(first);
    const batch2 = await driver.waitFor(
      (m) => m.type === "motion" && m.playerId === p1Id && (m.samples as unknown[]).length === 1,
      { after: dCursor },
    );
    expect(batch2.samples).toEqual(second);

    // Malformed batches are dropped silently: wrong tuple length, out of
    // range, empty, too many.
    p1.send({ type: "motion", samples: [[1, 0, 0, 1, 0, 0]] });
    p1.send({ type: "motion", samples: [[1, 0, 0, 99, 0, 0, 0]] });
    p1.send({ type: "motion", samples: [] });
    p1.send({
      type: "motion",
      samples: Array.from({ length: 17 }, () => [1, 0, 0, 1, 0, 0, 0]),
    });
    await sleep(200);
    expect(
      driver.countSince(dCursor, (m) => m.type === "motion" && m.playerId === p1Id),
    ).toBe(2);
    expect(host.countSince(hCursor, (m) => m.type === "motion")).toBe(0);
    expect(p2.countSince(p2Cursor, (m) => m.type === "motion")).toBe(0);
  });

  test("raw touch lists relay verbatim; malformed ones are dropped", async () => {
    // Seqs stay below the pause test's 99/100: p1's high-water mark carries
    // across this serial block, so a relayed seq >= 100 makes that frame stale.
    const dCursor = driver.mark();
    const touches = [
      { id: 0, x: 0.125, y: 0.5 },
      { id: 2, x: 1, y: 0 },
    ];
    p1.send({ type: "input", seq: 50, controls: { touch: touches } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id && m.seq === 50,
      { after: dCursor },
    );
    expect(frame.controls).toEqual({ touch: touches });

    p1.send({ type: "input", seq: 51, controls: { touch: [] } });
    const lifted = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id && m.seq === 51,
      { after: dCursor },
    );
    expect(lifted.controls).toEqual({ touch: [] });

    // Out of the box, not a finger slot: the whole frame is dropped.
    p1.send({ type: "input", seq: 52, controls: { touch: [{ id: 0, x: 1.5, y: 0 }] } });
    p1.send({ type: "input", seq: 53, controls: { touch: [{ id: 10, x: 0, y: 0 }] } });
    await sleep(200);
    expect(
      driver.countSince(dCursor, (m) => m.type === "input" && m.playerId === p1Id),
    ).toBe(2);
  });

  test("text messages relay to the driver in order, driver only", async () => {
    const hCursor = host.mark();
    const p2Cursor = p2.mark();
    const dCursor = driver.mark();

    p1.send({ type: "text", controlId: "answer", text: "Helsinki" });
    p1.send({ type: "text", controlId: "answer", text: "Helsinki" });
    p1.send({ type: "text", controlId: "chat", text: "gg 😀" });
    const chat = await driver.waitFor(
      (m) => m.type === "text" && m.playerId === p1Id && m.controlId === "chat",
      { after: dCursor },
    );
    expect(chat.text).toBe("gg 😀");
    // Events, not state: the identical second answer is relayed too.
    const texts = driver
      .since(dCursor)
      .filter((m) => m.type === "text" && m.playerId === p1Id);
    expect(texts.map((m) => (m.type === "text" ? m.text : null))).toEqual([
      "Helsinki",
      "Helsinki",
      "gg 😀",
    ]);

    // Too long, or a bad control id: dropped silently.
    p1.send({ type: "text", controlId: "answer", text: "x".repeat(1001) });
    p1.send({ type: "text", controlId: "Not An Id", text: "x" });
    await sleep(200);
    expect(
      driver.countSince(dCursor, (m) => m.type === "text" && m.playerId === p1Id),
    ).toBe(3);
    expect(host.countSince(hCursor, (m) => m.type === "text")).toBe(0);
    expect(p2.countSince(p2Cursor, (m) => m.type === "text")).toBe(0);
  });

  test("a posted background reaches every phone, and is served by its URL", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009077053de0000000c4944415478da63f8cfc0000003010100c9fe92ef0000000049454e44ae426082",
      "hex",
    );
    const cursors = [p1, p2, host, driver].map((c) => c.mark());
    const posted = await ctx.post("/api/kapula/driver/background?fit=contain", {
      headers: { Authorization: `Bearer ${driverToken}` },
      data: png,
    });
    expect(posted.status()).toBe(200);
    const { background } = (await posted.json()) as {
      background: { url: string; fit: string };
    };
    expect(background.fit).toBe("contain");

    for (const [i, player] of [p1, p2].entries()) {
      const msg = await player.waitForType("background_changed", {
        after: cursors[i],
      });
      expect(msg.background).toEqual(background);
    }
    // Players only: the driver has the HTTP answer, the host draws none.
    await sleep(200);
    expect(host.countSince(cursors[2], (m) => m.type === "background_changed")).toBe(0);
    expect(driver.countSince(cursors[3], (m) => m.type === "background_changed")).toBe(0);

    const image = await ctx.get(background.url);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await image.body()).equals(png)).toBe(true);

    // Not an image, or no driver token: refused, nothing broadcast.
    const svg = await ctx.post("/api/kapula/driver/background", {
      headers: { Authorization: `Bearer ${driverToken}` },
      data: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    });
    expect(svg.status()).toBe(415);
    const anonymous = await ctx.post("/api/kapula/driver/background", { data: png });
    expect(anonymous.status()).toBe(401);

    const cursor = p1.mark();
    const removed = await ctx.delete("/api/kapula/driver/background", {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    expect(removed.status()).toBe(200);
    const cleared = await p1.waitForType("background_changed", { after: cursor });
    expect(cleared.background).toBeNull();
    expect((await ctx.get(background.url)).status()).toBe(404);
  });

  test("lobby-only actions and joins are rejected mid-game", async () => {
    let cursor = p1.mark();
    p1.send({ type: "set_ready", ready: false });
    let error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("invalid_state");

    cursor = p1.mark();
    p1.send({ type: "update_profile", name: "Zeta" });
    error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("invalid_state");

    const join = await joinSession(ctx, joinCode);
    expect(join.error?.data?.code).toBe("CONFLICT");
  });

  test("schemas switch mid-game and input under the new one still relays", async () => {
    // The picker in the in-game menu is not gated on the driver's pause: the
    // player's choice of controls is theirs to make while the game runs.
    let cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "alt" });
    const updated = await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).playerId === p1Id,
      { after: cursor },
    );
    expect((updated.player as any).schemaId).toBe("alt");

    // seq is the phone's and keeps increasing across the switch (the phone
    // mounts a fresh controller for the new layout but shares one counter per
    // session); the server relays it untouched, so the driver's
    // highest-seq-wins rule sees the post-switch frames as the newest ones.
    const maxRelayed = Math.max(
      ...driver.messages
        .filter((m) => m.type === "input" && m.playerId === p1Id)
        .map((m) => m.seq as number),
    );
    const dCursor = driver.mark();
    p1.send({ type: "input", seq: maxRelayed + 1, controls: { jump: true } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id,
      { after: dCursor },
    );
    expect(frame.seq).toBe(maxRelayed + 1);
    expect(frame.controls).toEqual({ jump: true });

    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "tank" });
    await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).schemaId === "tank",
      { after: cursor },
    );
    p1.send({ type: "input", seq: maxRelayed + 2, controls: { fire: true } });
    const frame2 = await driver.waitFor(
      (m) =>
        m.type === "input" &&
        m.playerId === p1Id &&
        (m.controls as any).fire === true,
      { after: dCursor },
    );
    expect(frame2.seq).toBe(maxRelayed + 2);
  });

  test("the driver can set a player's schema, or everyone's", async () => {
    // Games change controls by phase (menu, driving, on foot), so the driver
    // pushes the layout instead of asking the player to pick it.
    let cursor = p1.mark();
    driver.send({ type: "set_schema", playerId: p1Id, schemaId: "alt" });
    const updated = await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).playerId === p1Id,
      { after: cursor },
    );
    expect((updated.player as any).schemaId).toBe("alt");

    // Input under the pushed layout relays like any other. Later tests in
    // this serial suite send hand-picked seqs, so stay just above the
    // high-water mark instead of jumping ahead of them.
    const dCursor = driver.mark();
    const seq =
      Math.max(
        ...driver.messages
          .filter((m) => m.type === "input" && m.playerId === p1Id)
          .map((m) => m.seq as number),
      ) + 1;
    p1.send({ type: "input", seq, controls: { jump: true } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id,
      { after: dCursor },
    );
    expect(frame.seq).toBe(seq);

    // Omitting playerId addresses every active player, one event each.
    cursor = p2.mark();
    const p1Cursor = p1.mark();
    driver.send({ type: "set_schema", schemaId: "tank" });
    for (const [client, id, after] of [
      [p1, p1Id, p1Cursor],
      [p2, p2Id, cursor],
    ] as const) {
      const evt = await client.waitFor(
        (m) =>
          m.type === "player_updated" &&
          (m.player as any).playerId === id &&
          (m.player as any).schemaId === "tank",
        { after },
      );
      expect((evt.player as any).schemaId).toBe("tank");
    }

    // A schema the config does not have, and a player who is not here.
    cursor = driver.mark();
    driver.send({ type: "set_schema", schemaId: "nope" });
    expect((await driver.waitForType("error", { after: cursor })).code).toBe(
      "unknown_schema",
    );
    cursor = driver.mark();
    driver.send({ type: "set_schema", playerId: "999999", schemaId: "tank" });
    expect((await driver.waitForType("error", { after: cursor })).code).toBe(
      "unknown_player",
    );

    // The player still owns their controls: they can switch back themselves.
    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "alt" });
    const own = await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).playerId === p1Id,
      { after: cursor },
    );
    expect((own.player as any).schemaId).toBe("alt");
    p1.send({ type: "select_schema", schemaId: "tank" });
    await p1.waitFor(
      (m) =>
        m.type === "player_updated" &&
        (m.player as any).playerId === p1Id &&
        (m.player as any).schemaId === "tank",
    );
  });

  test("pause stops input, allows schema switching, resume restores relay", async () => {
    let cursor = p1.mark();
    driver.send({ type: "pause" });
    const paused = await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "paused",
      { after: cursor },
    );
    expect(paused.reason).toBe("driver_command");

    const dCursor = driver.mark();
    p1.send({ type: "input", seq: 99, controls: { fire: true } });
    p1.send({ type: "motion", samples: [[1, 0, 0, 1, 0, 0, 0]] });
    await p1.settle();
    await sleep(200);
    expect(driver.countSince(dCursor, (m) => m.type === "input")).toBe(0);
    expect(driver.countSince(dCursor, (m) => m.type === "motion")).toBe(0);

    // Schemas may change while paused too; profiles may not.
    cursor = p1.mark();
    p1.send({ type: "select_schema", schemaId: "alt" });
    await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).schemaId === "alt",
      { after: cursor },
    );
    cursor = p1.mark();
    p1.send({ type: "update_profile", name: "Sneaky" });
    const error = await p1.waitForType("error", { after: cursor });
    expect(error.code).toBe("invalid_state");
    p1.send({ type: "select_schema", schemaId: "tank" });

    cursor = p1.mark();
    driver.send({ type: "resume" });
    await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );

    // The frame dropped while paused did not advance the player's seq mark.
    const rCursor = driver.mark();
    p1.send({ type: "input", seq: 100, controls: { fire: false } });
    const resumed = await driver.waitFor(
      (m) =>
        m.type === "input" &&
        m.playerId === p1Id &&
        (m.controls as any).fire === false,
      { after: rCursor },
    );
    expect(resumed.seq).toBe(100);
  });

  test("invalid driver transitions produce errors, not state changes", async () => {
    for (const type of ["start", "resume"]) {
      const cursor = driver.mark();
      driver.send({ type });
      const error = await driver.waitForType("error", { after: cursor });
      expect(error.code).toBe("invalid_state");
    }

    // Pausing twice: the second pause is rejected from "paused".
    let cursor = driver.mark();
    driver.send({ type: "pause" });
    await driver.waitFor(
      (m) => m.type === "state_changed" && m.state === "paused",
      { after: cursor },
    );
    cursor = driver.mark();
    driver.send({ type: "pause" });
    const error = await driver.waitForType("error", { after: cursor });
    expect(error.code).toBe("invalid_state");
    driver.send({ type: "resume" });
    await driver.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );
  });

  test("driver messages reach one player or all — never the host", async () => {
    const hCursor = host.mark();
    let cursor = p1.mark();
    const p2Cursor = p2.mark();
    driver.send({
      type: "message",
      playerId: p1Id,
      payload: { vibrateMs: 120 },
    });
    const targeted = await p1.waitForType("message", { after: cursor });
    expect(targeted.payload).toEqual({ vibrateMs: 120 });
    await sleep(200);
    expect(p2.countSince(p2Cursor, (m) => m.type === "message")).toBe(0);

    cursor = p1.mark();
    driver.send({ type: "message", payload: { round: 2 } });
    await p1.waitForType("message", { after: cursor });
    await p2.waitForType("message", { after: p2Cursor });
    expect(host.countSince(hCursor, (m) => m.type === "message")).toBe(0);

    // An unknown target is a no-op, not a crash.
    driver.send({ type: "message", playerId: "999999999", payload: {} });
    await driver.settle();
  });

  test("losing the driver mid-game auto-pauses; a reconnected driver resumes", async () => {
    const p1Cursor = p1.mark();
    const hCursor = host.mark();
    driver.close();

    await p1.waitForType("driver_disconnected", { after: p1Cursor });
    const paused = await p1.waitForType("state_changed", { after: p1Cursor });
    expect(paused.state).toBe("paused");
    expect(paused.reason).toBe("driver_disconnected");
    await host.waitFor(
      (m) => m.type === "state_changed" && m.state === "paused",
      { after: hCursor },
    );

    // Reconnect with the stored driver token; the snapshot shows paused and
    // the driver must resume explicitly.
    const cursor = p1.mark();
    driver = await WsClient.open(`?role=driver&token=${driverToken}`, {
      label: "driver-reconnected",
    });
    const snap = await driver.waitForType("snapshot");
    expect((snap.snapshot as any).state).toBe("paused");
    await p1.waitForType("driver_connected", { after: cursor });

    driver.send({ type: "resume" });
    await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );
  });

  test("input rate limits: floods are dropped, extreme floods disconnect", async () => {
    // 300 frames in one burst: the 120/s cap must drop some (at most two
    // 1-second windows can be straddled, so under 300 must arrive).
    const dCursor = driver.mark();
    for (let i = 0; i < 300; i++) {
      p1.send({ type: "input", seq: 1000 + i, controls: { fire: i % 2 === 0 } });
    }
    await p1.settle();
    await sleep(300);
    const relayed = driver.countSince(
      dCursor,
      (m) => m.type === "input" && m.playerId === p1Id && (m.seq as number) >= 1000,
    );
    expect(relayed).toBeGreaterThan(0);
    expect(relayed).toBeLessThan(300);
    expect(p1.open).toBe(true);

    // Far beyond the kill threshold (600/s) the socket is closed with 4008.
    for (let i = 0; i < 1500; i++) {
      p1.send({ type: "input", seq: 3000 + i, controls: { fire: true } });
    }
    expect((await p1.waitForClose(15_000)).code).toBe(4008);

    // The token is still good: reconnect (fresh rate window) and keep playing.
    p1 = await WsClient.open(`?role=player&token=${p1Token}`, {
      label: "p1-after-4008",
    });
    await p1.waitForType("snapshot");
    p1.send({ type: "input", seq: 9000, controls: { fire: true } });
    await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id && m.seq === 9000,
    );
  });

  test("a reloaded player's seq relays as sent; a stale one is dropped", async () => {
    // seq is phone-owned and must keep increasing across a reload (the phone
    // seeds it from the wall clock at page load for exactly this reason). The
    // server relays it untouched and drops anything at or below the last
    // relayed seq — so a client that did restart at 1 would be silently
    // muted rather than confusing the driver's highest-seq-wins rule.
    const maxRelayed = Math.max(
      ...driver.messages
        .filter((m) => m.type === "input" && m.playerId === p1Id)
        .map((m) => m.seq as number),
    );
    expect(maxRelayed).toBeGreaterThan(1);

    const dCursor = driver.mark();
    p1.close();
    await driver.waitFor(
      (m) => m.type === "player_disconnected" && m.playerId === p1Id,
      { after: dCursor },
    );

    p1 = await WsClient.open(`?role=player&token=${p1Token}`, {
      label: "p1-reloaded",
    });
    await p1.waitForType("snapshot");

    // Non-increasing frames after the reconnect are dropped.
    p1.send({ type: "input", seq: 1, controls: { fire: true } });
    p1.send({ type: "input", seq: maxRelayed, controls: { fire: true } });
    await p1.settle();
    await sleep(200);
    expect(
      driver.countSince(dCursor, (m) => m.type === "input" && m.playerId === p1Id),
    ).toBe(0);

    // A higher seq relays exactly as sent.
    p1.send({ type: "input", seq: maxRelayed + 1, controls: { fire: true } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === p1Id,
      { after: dCursor },
    );
    expect(frame.seq).toBe(maxRelayed + 1);
    expect(frame.controls).toEqual({ fire: true });

    // ...and so does a wall-clock-seeded one, gaps included.
    const seeded = Date.now();
    p1.send({ type: "input", seq: seeded, controls: { fire: false } });
    const frame2 = await driver.waitFor(
      (m) =>
        m.type === "input" &&
        m.playerId === p1Id &&
        (m.controls as any).fire === false,
      { after: dCursor },
    );
    expect(frame2.seq).toBe(seeded);
  });

  test("a player can leave — even while paused — and the slot is freed", async () => {
    // The reported trap: a paused session offered no exit. Leave must work
    // from any state, so exercise it from paused specifically.
    let cursor = p2.mark();
    driver.send({ type: "pause" });
    await p2.waitFor(
      (m) => m.type === "state_changed" && m.state === "paused",
      { after: cursor },
    );

    const others = [driver, host, p1];
    const cursors = others.map((c) => c.mark());
    p2.send({ type: "leave" });
    // Leaving is an orderly, non-reconnectable exit: a normal close, and
    // every remaining role hears player_left (not player_disconnected).
    expect((await p2.waitForClose()).code).toBe(1000);
    for (const [i, client] of others.entries()) {
      await client.waitFor(
        (m) => m.type === "player_left" && m.playerId === p2Id,
        { after: cursors[i] },
      );
      expect(
        client.countSince(
          cursors[i],
          (m) => m.type === "player_disconnected" && m.playerId === p2Id,
        ),
      ).toBe(0);
    }

    // The token died with the slot.
    const dead = await WsClient.open(`?role=player&token=${p2Token}`, {
      label: "p2-after-leave",
    });
    expect((await dead.waitForClose()).code).toBe(4004);

    // The roster no longer counts p2 and its color is claimable again.
    const info = await getJoinInfo(ctx, joinCode);
    expect(info.data.playerCount).toBe(2);
    expect(info.data.availableColors).toContain(COLORS[1]);

    // Back to in_progress for the remaining tests.
    cursor = p1.mark();
    driver.send({ type: "resume" });
    await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );
  });

  test("a stored player credential can be verified without connecting", async () => {
    // The landing page asks this before showing "you are in a game".
    const status = await getPlayerStatus(ctx, p1Token);
    expect(status.data).toMatchObject({ sessionId, state: "in_progress" });
    expect(status.data.name).toBeTruthy();
    const bogus = await getPlayerStatus(ctx, "not-a-token");
    expect(bogus.data).toBeNull();
  });

  test("driver end terminates the session for every role", async () => {
    // p2 left in the previous test; only the remaining sockets get the end.
    const clients = [driver, host, p1];
    const cursors = clients.map((c) => c.mark());
    driver.send({ type: "end" });

    for (const [i, client] of clients.entries()) {
      const change = await client.waitFor(
        (m) => m.type === "state_changed" && m.state === "ended",
        { after: cursors[i] },
      );
      expect(change.reason).toBe("driver_command");
      expect((await client.waitForClose()).code).toBe(4005);
    }

    // Dead credentials: driver token, player token and join code all expire.
    const deadDriver = await WsClient.open(`?role=driver&token=${driverToken}`);
    expect((await deadDriver.waitForClose()).code).toBe(4004);
    const deadPlayer = await WsClient.open(`?role=player&token=${p1Token}`);
    expect((await deadPlayer.waitForClose()).code).toBe(4004);
    const deadJoin = await joinSession(ctx, joinCode);
    expect(deadJoin.error?.data?.code).toBe("NOT_FOUND");
    const mine = await hostCall(ctx, "getMySession");
    expect(mine.data).toBeNull();
    // Nothing may ever present the session as ongoing again.
    const status = await getPlayerStatus(ctx, p1Token);
    expect(status.data).toBeNull();
  });
});

/**
 * Return to lobby (between rounds) and late join (`config.allowLateJoin`):
 * both are additions under version 1, so they get their own
 * session rather than disturbing the flow suite above.
 */
test.describe.serial("lobby round trip and late join", () => {
  let ctx: APIRequestContext;
  let joinCode: string;
  let driver: WsClient;
  let p1: WsClient;
  let p1Id: string;

  test.beforeAll(async () => {
    ctx = await newContext();
    await devLogin(ctx, uniqueEmail("kapula-late-join"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, {
      game: "Late Join Test",
      minPlayers: 1,
      maxPlayers: 4,
      allowLateJoin: true,
    });
    expect(setup.status).toBe(200);
    joinCode = setup.body.joinCode!;
    driver = await WsClient.open("", {
      url: setup.body.wsUrl,
      label: "late-driver",
    });
    await driver.waitForType("snapshot");
  });

  test.afterAll(async () => {
    for (const client of [driver, p1]) client?.close();
    await ctx?.dispose();
  });

  test("a player can join a game that is already running", async () => {
    const first = await joinSession(ctx, joinCode);
    p1Id = first.data.playerId;
    p1 = await WsClient.open(`?role=player&token=${first.data.playerToken}`, {
      label: "late-p1",
    });
    await p1.waitForType("snapshot");
    p1.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    driver.send({ type: "start" });
    await p1.waitForType("state_changed");

    // The join screen asks the server, not the state, whether it may join.
    const info = await getJoinInfo(ctx, joinCode);
    expect(info.data.state).toBe("in_progress");
    expect(info.data.acceptingPlayers).toBe(true);

    const dCursor = driver.mark();
    const late = await joinSession(ctx, joinCode);
    expect(late.error).toBeUndefined();
    const joined = await driver.waitForType("player_joined", { after: dCursor });
    expect((joined.player as any).playerId).toBe(late.data.playerId);

    // A late joiner plays at once — no ready, no lobby.
    const p2 = await WsClient.open(
      `?role=player&token=${late.data.playerToken}`,
      { label: "late-p2" },
    );
    const snap = await p2.waitForType("snapshot");
    expect((snap.snapshot as any).state).toBe("in_progress");
    const seq = Date.now();
    p2.send({ type: "input", seq, controls: { fire: true } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === late.data.playerId,
      { after: dCursor },
    );
    expect(frame.seq).toBe(seq);
    p2.close();
  });

  test("the driver sends everyone back to the lobby, ready flags cleared", async () => {
    const cursor = p1.mark();
    driver.send({ type: "lobby" });
    const back = await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "waiting_for_players",
      { after: cursor },
    );
    expect(back.reason).toBe("driver_command");

    // The previous round's ready says nothing about this one.
    const cleared = await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).playerId === p1Id,
      { after: cursor },
    );
    expect((cleared.player as any).ready).toBe(false);

    // ...so start waits for a fresh ready-up.
    let dCursor = driver.mark();
    driver.send({ type: "start" });
    expect((await driver.waitForType("error", { after: dCursor })).code).toBe(
      "cannot_start",
    );

    // Lobby-only actions work again, and the round restarts.
    p1.send({ type: "update_profile", name: "Round Two" });
    await p1.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).name === "Round Two",
    );
    p1.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    dCursor = driver.mark();
    driver.send({ type: "start" });
    await p1.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
    );

    driver.send({ type: "end" });
    await driver.waitForClose();
  });

  test("the driver kicks a player, who can join again", async () => {
    // Its own session: the round-trip test above ended the shared one.
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, { minPlayers: 1 });
    const kicker = await WsClient.open("", {
      url: setup.body.wsUrl,
      label: "kick-driver",
    });
    await kicker.waitForType("snapshot");
    const code = setup.body.joinCode!;

    // Kick frees the slot like leave does — it is removal, not a ban.
    const join = await joinSession(ctx, code);
    expect(join.error).toBeUndefined();
    const victim = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "kicked" },
    );
    await victim.waitForType("snapshot");

    const dCursor = kicker.mark();
    kicker.send({ type: "kick", playerId: join.data.playerId });
    const left = await kicker.waitFor(
      (m) => m.type === "player_left" && m.playerId === join.data.playerId,
      { after: dCursor },
    );
    expect(left.playerId).toBe(join.data.playerId);
    expect((await victim.waitForClose()).code).toBe(4011);

    // The token is dead and the name/color slot is free again.
    const dead = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "kicked-retry" },
    );
    expect((await dead.waitForClose()).code).toBe(4004);
    const status = await getPlayerStatus(ctx, join.data.playerToken);
    expect(status.data).toBeNull();
    const rejoin = await joinSession(ctx, code);
    expect(rejoin.error).toBeUndefined();
    expect(rejoin.data.playerId).not.toBe(join.data.playerId);

    // Kicking someone who is not here says so.
    let cursor = kicker.mark();
    kicker.send({ type: "kick", playerId: join.data.playerId });
    expect((await kicker.waitForType("error", { after: cursor })).code).toBe(
      "unknown_player",
    );

    // The host can do it too, through the host API, with no driver socket involved.
    cursor = kicker.mark();
    const kicked = await hostCall(ctx, "kickPlayer", {
      playerId: rejoin.data.playerId,
    });
    expect(kicked.error).toBeUndefined();
    await kicker.waitFor(
      (m) => m.type === "player_left" && m.playerId === rejoin.data.playerId,
      { after: cursor },
    );
    const hostMiss = await hostCall(ctx, "kickPlayer", {
      playerId: rejoin.data.playerId,
    });
    expect(hostMiss.error?.data?.code).toBe("NOT_FOUND");

    kicker.send({ type: "end" });
    await kicker.waitForClose();
  });

  test("a session without the flag refuses a late join", async () => {
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, { minPlayers: 1 });
    const strict = await WsClient.open("", {
      url: setup.body.wsUrl,
      label: "strict-driver",
    });
    await strict.waitForType("snapshot");
    const join = await joinSession(ctx, setup.body.joinCode!);
    const player = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "strict-p1" },
    );
    await player.waitForType("snapshot");
    player.send({ type: "set_ready", ready: true });
    await strict.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    strict.send({ type: "start" });
    await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
    );

    const info = await getJoinInfo(ctx, setup.body.joinCode!);
    expect(info.data.acceptingPlayers).toBe(false);
    const late = await joinSession(ctx, setup.body.joinCode!);
    expect(late.error?.data?.code).toBe("CONFLICT");
    expect(late.error?.message).toContain("not accepting");

    strict.send({ type: "end" });
    await strict.waitForClose();
    player.close();
  });
});

/**
 * Roster sessions: the driver predefines the players (the lost-session
 * recovery path) and joining means picking one's own slot.
 */
test.describe.serial("session without a lobby (skipLobby)", () => {
  let ctx: APIRequestContext;
  let joinCode: string;
  let driver: WsClient;

  test.beforeAll(async () => {
    ctx = await newContext();
    await devLogin(ctx, uniqueEmail("kapula-skip-lobby"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, {
      game: "Remote Test",
      minPlayers: 1,
      maxPlayers: 2,
      skipLobby: true,
    });
    expect(setup.status).toBe(200);
    joinCode = setup.body.joinCode!;
    driver = await WsClient.open("", { url: setup.body.wsUrl, label: "remote-driver" });
    await driver.waitForType("snapshot");
  });

  test.afterAll(async () => {
    driver?.close();
    await ctx?.dispose();
  });

  test("the driver starts with nobody joined; players land on the controller", async () => {
    const cursor = driver.mark();
    driver.send({ type: "start" });
    const started = await driver.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );
    expect(started.reason).toBe("driver_command");

    const info = await getJoinInfo(ctx, joinCode);
    expect(info.data.acceptingPlayers).toBe(true);
    const joined = await joinSession(ctx, joinCode);
    expect(joined.error).toBeUndefined();
    const player = await WsClient.open(
      `?role=player&token=${joined.data.playerToken}`,
      { label: "remote-player" },
    );
    const snap = await player.waitForType("snapshot");
    expect((snap.snapshot as any).state).toBe("in_progress");
    const seq = Date.now();
    player.send({ type: "input", seq, controls: { left: true } });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && m.playerId === joined.data.playerId,
      { after: cursor },
    );
    expect(frame.seq).toBe(seq);
    player.close();
  });
});

test.describe.serial("roster session", () => {
  const ROSTER = [
    { name: "Ada", color: "#FF6B6B" },
    { name: "Grace", color: "#6BCB77" },
  ];
  let ctx: APIRequestContext;
  let joinCode: string;
  let driver: WsClient;
  let ada: WsClient;
  let grace: WsClient;

  test.beforeAll(async () => {
    ctx = await newContext();
    await devLogin(ctx, uniqueEmail("kapula-ws-roster"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, {
      game: "Roster Test",
      roster: ROSTER,
      // Also the suite that exercises the real-gamepad option end to end.
      allowPhysicalGamepad: true,
    });
    expect(setup.status).toBe(200);
    joinCode = setup.body.joinCode!;
    driver = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "roster-driver" },
    );
    await driver.waitForType("snapshot");
  });

  test.afterAll(async () => {
    for (const client of [driver, ada, grace]) client?.close();
    await ctx?.dispose();
  });

  test("setup rejects rosters that disagree with the player counts", async () => {
    const bad = await driverSetup(ctx, "ZZZZZZ", {
      roster: ROSTER,
      maxPlayers: 5,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.issues?.join(" ")).toContain("maxPlayers");
  });

  test("join info lists the roster and joining takes a slot", async () => {
    const info = await getJoinInfo(ctx, joinCode);
    expect(info.data.maxPlayers).toBe(2);
    expect(info.data.roster).toEqual([
      { ...ROSTER[0], taken: false },
      { ...ROSTER[1], taken: false },
    ]);

    // No pick, unknown pick: refused.
    const noPick = await joinSession(ctx, joinCode);
    expect(noPick.error?.data?.code).toBe("CONFLICT");
    expect(noPick.error?.message).toContain("Pick");
    const unknown = await joinSession(ctx, joinCode, "Linus");
    expect(unknown.error?.message).toContain("not in this game");

    // Picking is case-insensitive and yields the slot's exact name + color.
    const join = await joinSession(ctx, joinCode, "ada");
    expect(join.error).toBeUndefined();
    ada = await WsClient.open(`?role=player&token=${join.data.playerToken}`, {
      label: "ada",
    });
    const snap = await ada.waitForType("snapshot");
    expect((snap.snapshot as any).players).toEqual([
      expect.objectContaining({ name: "Ada", color: "#FF6B6B" }),
    ]);
    expect((snap.snapshot as any).config.roster).toEqual(ROSTER);

    // The slot is taken now — for everyone, including a second Ada.
    const taken = await getJoinInfo(ctx, joinCode);
    expect(taken.data.roster[0].taken).toBe(true);
    const again = await joinSession(ctx, joinCode, "Ada");
    expect(again.error?.message).toContain("already joined");
  });

  test("names and colors are locked; start waits for the whole roster", async () => {
    let cursor = ada.mark();
    ada.send({ type: "update_profile", name: "Someone Else" });
    let error = await ada.waitForType("error", { after: cursor });
    expect(error.code).toBe("profile_locked");

    ada.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    cursor = driver.mark();
    driver.send({ type: "start" });
    error = await driver.waitForType("error", { after: cursor });
    expect(error.code).toBe("cannot_start");
    expect(String(error.message)).toContain("1 more player");

    const join = await joinSession(ctx, joinCode, "Grace");
    expect(join.error).toBeUndefined();
    grace = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "grace" },
    );
    const graceSnap = await grace.waitForType("snapshot");
    expect((graceSnap.snapshot as any).config.allowPhysicalGamepad).toBe(true);
    // With the option allowed, the reserved id selects like any schema and
    // the driver learns of it through the usual player_updated.
    cursor = driver.mark();
    grace.send({ type: "select_schema", schemaId: PHYSICAL_GAMEPAD_SCHEMA_ID });
    await driver.waitFor(
      (m) =>
        m.type === "player_updated" &&
        (m.player as any).name === "Grace" &&
        (m.player as any).schemaId === PHYSICAL_GAMEPAD_SCHEMA_ID,
      { after: cursor },
    );
    grace.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) =>
        m.type === "player_updated" &&
        (m.player as any).name === "Grace" &&
        (m.player as any).ready === true,
    );

    cursor = ada.mark();
    driver.send({ type: "start" });
    await ada.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
      { after: cursor },
    );

    // A physical frame relays verbatim — trigger scalars included.
    const dCursor = driver.mark();
    grace.send({
      type: "input",
      seq: 1,
      controls: { "left-stick": { x: 0.5, y: -0.25 }, dpad: "ur", a: true, rt: 0.75, lt: 0 },
    });
    const frame = await driver.waitFor(
      (m) => m.type === "input" && (m.controls as any).rt === 0.75,
      { after: dCursor },
    );
    expect(frame.controls).toEqual({
      "left-stick": { x: 0.5, y: -0.25 },
      dpad: "ur",
      a: true,
      rt: 0.75,
      lt: 0,
    });
    driver.send({ type: "end" });
  });
});

/**
 * Driver keys: the standalone-driver path — a game creates its own session
 * with its owner's key instead of a human reading a setup code out of the
 * web app. Everything else about the session is identical.
 */
test.describe.serial("driver keys", () => {
  let ctx: APIRequestContext;
  let cookie: string;
  let key: string;

  test.beforeAll(async () => {
    ctx = await newContext();
    cookie = await devLogin(ctx, uniqueEmail("kapula-driver-key"));
    const created = await hostCall(ctx, "createDriverKey", {
      name: "Tank Game on the PC",
    });
    expect(created.error).toBeUndefined();
    key = created.data.key;
  });

  test.afterAll(async () => {
    await ctx?.dispose();
  });

  test("the key is returned once, listed by prefix only", async () => {
    expect(key.startsWith("kpk_")).toBe(true);
    const list = await hostCall(ctx, "listDriverKeys");
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe("Tank Game on the PC");
    expect(list.data[0].prefix).toBe(key.slice(0, 12));
    expect(list.data[0].lastUsedAt).toBeNull();
    // The plain key is nowhere in the listing — only its hash is stored.
    expect(JSON.stringify(list.data)).not.toContain(key);
  });

  test("an unknown or malformed key is refused", async () => {
    expect((await driverCreate(ctx, "kpk_nope")).status).toBe(401);
    const missing = await ctx.post("/api/kapula/driver/create", {
      headers: { "x-kapula-ratelimit-key": crypto.randomUUID() },
      data: {},
    });
    expect(missing.status()).toBe(401);
  });

  test("a key creates a playable session with no host in a browser", async () => {
    const created = await driverCreate(ctx, key, {
      config: { game: "Keyed Game", minPlayers: 1 },
    });
    expect(created.status).toBe(200);
    expect(created.body.protocolVersion).toBe(KAPULA_PROTOCOL_VERSION);
    expect(created.body.joinCode).toMatch(CODE_PATTERN);

    // The owner sees it in their session list, under the key's name — a
    // slot of its own, not their hosted session.
    const list0 = await hostCall(ctx, "listMySessions");
    const mine = list0.data.find(
      (s: { sessionId: string }) => s.sessionId === created.body.sessionId,
    );
    expect(mine.joinCode).toBe(created.body.joinCode);
    expect(mine.state).toBe("waiting_for_players");
    expect(mine.driverKeyName).toBe("Tank Game on the PC");
    expect(mine.driverKeyId).not.toBeNull();
    // Nobody ever needs the setup code: it was consumed on the way through.
    expect(mine.setupCode).toBeNull();
    expect((await hostCall(ctx, "getMySession")).data).toBeNull();

    // Using the key stamps it, so a user can tell live keys from stale ones.
    const list = await hostCall(ctx, "listDriverKeys");
    expect(list.data[0].lastUsedAt).not.toBeNull();

    // And the session plays: driver connects, player joins and readies.
    const driver = await WsClient.open("", {
      url: created.body.wsUrl,
      label: "key-driver",
    });
    await driver.waitForType("snapshot");
    const join = await joinSession(ctx, created.body.joinCode!);
    expect(join.error).toBeUndefined();
    const player = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "key-player" },
    );
    await player.waitForType("snapshot");
    player.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    driver.send({ type: "start" });
    await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
    );

    // A second create with the same key is refused: one session per key.
    const second = await driverCreate(ctx, key);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already has an active session");

    // Other slots are independent: the owner can still host a session on
    // the web, and another key can open its own.
    const hosted = await hostCall(ctx, "createSession");
    expect(hosted.error).toBeUndefined();
    const otherKey = await hostCall(ctx, "createDriverKey", {
      name: "Living room PC",
    });
    const other = await driverCreate(ctx, otherKey.data.key, {
      config: { game: "Remote", skipLobby: true },
    });
    expect(other.status).toBe(200);
    const all = await hostCall(ctx, "listMySessions");
    expect(all.data.map((s: { driverKeyName: string | null }) => s.driverKeyName)).toEqual([
      null,
      "Tank Game on the PC",
      "Living room PC",
    ]);
    // Host actions take the session id; someone else's id is not found.
    const endOther = await hostCall(ctx, "endMySession", {
      sessionId: other.body.sessionId,
    });
    expect(endOther.error).toBeUndefined();
    const stranger = await newContext();
    await devLogin(stranger, uniqueEmail("kapula-key-stranger"));
    const foreign = await hostCall(stranger, "endMySession", {
      sessionId: created.body.sessionId,
    });
    expect(foreign.error?.data?.code).toBe("NOT_FOUND");
    await stranger.dispose();
    // No id: the hosted session, as before.
    expect((await hostCall(ctx, "endMySession")).error).toBeUndefined();
    expect((await hostCall(ctx, "listMySessions")).data).toHaveLength(1);

    // replaceExisting is the restart-after-a-crash path: the old session
    // ends for its players first.
    const pCursor = player.mark();
    const replaced = await driverCreate(ctx, key, { replaceExisting: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.sessionId).not.toBe(created.body.sessionId);
    const ended = await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "ended",
      { after: pCursor },
    );
    expect(ended.reason).toBe("host_ended");
    expect((await player.waitForClose()).code).toBe(4005);
    expect((await driver.waitForClose()).code).toBe(4005);

    // Clean up the replacement session.
    const last = await WsClient.open("", {
      url: replaced.body.wsUrl,
      label: "key-driver-2",
    });
    await last.waitForType("snapshot");
    last.send({ type: "end" });
    await last.waitForClose();
  });

  test("a revoked key stops working", async () => {
    const list = await hostCall(ctx, "listDriverKeys");
    const tank = list.data.find(
      (k: { name: string }) => k.name === "Tank Game on the PC",
    );
    const revoked = await hostCall(ctx, "revokeDriverKey", {
      id: tank.id,
    });
    expect(revoked.error).toBeUndefined();
    expect((await driverCreate(ctx, key)).status).toBe(401);
    expect(
      (await hostCall(ctx, "listDriverKeys")).data.map(
        (k: { name: string }) => k.name,
      ),
    ).toEqual(["Living room PC"]);
    // Revoking twice is not found, and neither is someone else's key.
    const again = await hostCall(ctx, "revokeDriverKey", {
      id: tank.id,
    });
    expect(again.error?.data?.code).toBe("NOT_FOUND");
  });
});

test.describe.serial("private sessions", () => {
  let owner: APIRequestContext;
  let partner: APIRequestContext;
  let stranger: APIRequestContext;
  const partnerEmail = uniqueEmail("kapula-private-partner");
  let session: Awaited<ReturnType<typeof driverCreate>>;
  let driver: WsClient;

  test.beforeAll(async () => {
    owner = await newContext();
    partner = await newContext();
    stranger = await newContext();
    await devLogin(owner, uniqueEmail("kapula-private-owner"));
    await devLogin(partner, partnerEmail);
    await devLogin(stranger, uniqueEmail("kapula-private-stranger"));
    // Linked by email, typed in any case: stored lowercased.
    const key = await hostCall(owner, "createDriverKey", {
      name: "Living room PC",
      linkedEmails: [partnerEmail.toUpperCase()],
    });
    expect(key.error).toBeUndefined();
    expect(key.data.linkedEmails).toEqual([partnerEmail.toLowerCase()]);
    session = await driverCreate(owner, key.data.key, {
      config: { game: "Remote", skipLobby: true, private: true, maxPlayers: 2 },
    });
    expect(session.status).toBe(200);
    driver = await WsClient.open("", { url: session.body.wsUrl, label: "private-driver" });
    await driver.waitForType("snapshot");
    driver.send({ type: "start" });
    await driver.waitFor((m) => m.type === "state_changed" && m.state === "in_progress");
  });

  test.afterAll(async () => {
    driver?.send({ type: "end" });
    driver?.close();
    for (const ctx of [owner, partner, stranger]) await ctx?.dispose();
  });

  test("the join code leads nowhere; the join link is the landing page", async () => {
    expect(session.body.joinUrl).toBe(`${HOST_URL}/`);
    const info = await getJoinInfo(stranger, session.body.joinCode!);
    expect(info.data).toBeNull();
    const join = await joinSession(stranger, session.body.joinCode!);
    expect(join.error?.data?.code).toBe("NOT_FOUND");
  });

  test("the owner and linked people see it named after the key and join in one tap", async () => {
    for (const ctx of [owner, partner]) {
      const list = await hostCall(ctx, "listPrivateSessions");
      expect(list.data).toHaveLength(1);
      expect(list.data[0].name).toBe("Living room PC");
      expect(list.data[0].acceptingPlayers).toBe(true);
    }
    const cursor = driver.mark();
    const joined = await hostCall(partner, "joinPrivateSession", {
      sessionId: session.body.sessionId,
    });
    expect(joined.error).toBeUndefined();
    const player = await WsClient.open(
      `?role=player&token=${joined.data.playerToken}`,
      { label: "private-partner" },
    );
    const snap = await player.waitForType("snapshot");
    expect((snap.snapshot as any).state).toBe("in_progress");
    player.send({ type: "text", controlId: "keyboard", text: "hello pc" });
    const text = await driver.waitFor((m) => m.type === "text", { after: cursor });
    expect(text.text).toBe("hello pc");
    player.close();
  });

  test("anyone else neither sees nor joins it", async () => {
    expect((await hostCall(stranger, "listPrivateSessions")).data).toEqual([]);
    const join = await hostCall(stranger, "joinPrivateSession", {
      sessionId: session.body.sessionId,
    });
    expect(join.error?.data?.code).toBe("NOT_FOUND");
  });

  test("unlinking an email closes the door for the next join", async () => {
    const keys = await hostCall(owner, "listDriverKeys");
    const saved = await hostCall(owner, "setDriverKeyEmails", {
      id: keys.data[0].id,
      linkedEmails: [],
    });
    expect(saved.data.linkedEmails).toEqual([]);
    expect((await hostCall(partner, "listPrivateSessions")).data).toEqual([]);
    // The owner keeps access regardless.
    expect((await hostCall(owner, "listPrivateSessions")).data).toHaveLength(1);
  });
});

/**
 * The WebSocket liveness probe: the server pings every KEEPALIVE_INTERVAL_MS
 * and terminates a socket that did not answer the previous ping, so a client
 * whose network died silently stops holding a driver or player slot. The real
 * interval is 30 s; this runs only against a backend booted with a short
 * KAPULA_WS_KEEPALIVE_MS (the same value must be in this process's
 * environment so the test knows how long to wait).
 */
test.describe.serial("websocket keepalive", () => {
  const intervalMs = Number(process.env.KAPULA_WS_KEEPALIVE_MS);
  test.skip(
    !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 5_000,
    "set KAPULA_WS_KEEPALIVE_MS (<= 5000) on the host and here",
  );

  let ctx: APIRequestContext;

  test.beforeAll(async () => {
    ctx = await newContext();
  });

  test.afterAll(async () => {
    await ctx?.dispose();
  });

  test("a socket that stops answering pings is terminated", async () => {
    await devLogin(ctx, uniqueEmail("kapula-ws-keepalive"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, { minPlayers: 1 });
    const join = await joinSession(ctx, setup.body.joinCode!);

    // `autoPong: false` is a network that died without closing the socket:
    // the process still has an open connection, but nothing answers.
    const dead = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "keepalive-dead", autoPong: false },
    );
    await dead.waitForType("snapshot");

    // A well-behaved socket in the same session is the control: it must
    // still be open when the silent one is gone.
    const driver = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "keepalive-driver" },
    );
    await driver.waitForType("snapshot");

    // Terminated within two ticks of going silent (1006: no close handshake).
    const closed = await dead.waitForClose(intervalMs * 4);
    expect(closed.code).toBe(1006);
    expect(driver.open).toBe(true);

    // The driver hears about it like any other disconnect.
    await driver.waitFor(
      (m) => m.type === "player_disconnected" && m.playerId === join.data.playerId,
    );

    driver.send({ type: "end" });
    await driver.waitForClose();
  });
});

/**
 * The driver-lost watchdog: a session without its driver for the timeout
 * ends for everyone with reason driver_lost. The real timeout is 3 minutes;
 * this runs only against a backend booted with a short
 * KAPULA_DRIVER_LOST_TIMEOUT_MS (the same value must be in this process's
 * environment so the test knows how long to wait).
 */
test.describe.serial("driver-lost watchdog", () => {
  const timeoutMs = Number(process.env.KAPULA_DRIVER_LOST_TIMEOUT_MS);
  test.skip(
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000,
    "set KAPULA_DRIVER_LOST_TIMEOUT_MS (<= 20000) on the host and here",
  );

  let ctx: APIRequestContext;
  let cookie: string;

  test.beforeAll(async () => {
    ctx = await newContext();
  });

  test.afterAll(async () => {
    await ctx?.dispose();
  });

  test("a dropped driver that stays away ends the session as driver_lost", async () => {
    cookie = await devLogin(ctx, uniqueEmail("kapula-ws-lost"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode, { minPlayers: 1 });
    const host = await WsClient.open(
      `?role=host&sessionId=${created.sessionId}`,
      { headers: { Cookie: cookie }, label: "lost-host" },
    );
    await host.waitForType("snapshot");
    const join = await joinSession(ctx, setup.body.joinCode!);
    const player = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "lost-player" },
    );
    await player.waitForType("snapshot");

    let driver = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "lost-driver" },
    );
    await driver.waitForType("snapshot");
    player.send({ type: "set_ready", ready: true });
    await driver.waitFor(
      (m) => m.type === "player_updated" && (m.player as any).ready === true,
    );
    driver.send({ type: "start" });
    await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "in_progress",
    );

    // A drop shorter than the timeout is survivable: the driver comes back
    // and the clock resets.
    let cursor = player.mark();
    driver.close();
    await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "paused",
      { after: cursor },
    );
    await sleep(timeoutMs / 2);
    driver = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "lost-driver-2" },
    );
    await driver.waitForType("snapshot");
    await sleep(timeoutMs / 2 + 200);
    expect(player.open).toBe(true);

    // Gone for the whole timeout: ended for every role, reason driver_lost,
    // and the credentials are dead.
    cursor = player.mark();
    const hCursor = host.mark();
    driver.close();
    const ended = await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "ended",
      { after: cursor, timeoutMs: timeoutMs + 8000 },
    );
    expect(ended.reason).toBe("driver_lost");
    const hostEnded = await host.waitFor(
      (m) => m.type === "state_changed" && m.state === "ended",
      { after: hCursor },
    );
    expect(hostEnded.reason).toBe("driver_lost");
    expect((await player.waitForClose()).code).toBe(4005);
    expect((await host.waitForClose()).code).toBe(4005);

    const status = await getPlayerStatus(ctx, join.data.playerToken);
    expect(status.data).toBeNull();
    const mine = await hostCall(ctx, "getMySession");
    expect(mine.data).toBeNull();
    const late = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "lost-driver-late" },
    );
    expect((await late.waitForClose()).code).toBe(4004);
  });

  test("a driver that claims a session but never connects loses it too", async () => {
    await devLogin(ctx, uniqueEmail("kapula-ws-lost2"));
    const created = await createHostSession(ctx);
    const setup = await driverSetup(ctx, created.setupCode);
    const join = await joinSession(ctx, setup.body.joinCode!);
    const player = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "never-player" },
    );
    await player.waitForType("snapshot");
    const ended = await player.waitFor(
      (m) => m.type === "state_changed" && m.state === "ended",
      { timeoutMs: timeoutMs + 8000 },
    );
    expect(ended.reason).toBe("driver_lost");
    expect((await player.waitForClose()).code).toBe(4005);
  });
});

test.describe.serial("host escape hatch on a live session", () => {
  let ctx: APIRequestContext;

  test.beforeAll(async () => {
    ctx = await newContext();
  });

  test.afterAll(async () => {
    await ctx?.dispose();
  });

  test("host end reaches driver and players as host_ended + 4005", async () => {
    await devLogin(ctx, uniqueEmail("kapula-ws-host2"));
    const created = await createHostSession(ctx);

    // Only one active session per user.
    const conflict = await hostCall(ctx, "createSession");
    expect(conflict.error?.data?.code).toBe("CONFLICT");

    // Setup without a config falls back to the generic gamepad defaults.
    const setup = await driverSetup(ctx, created.setupCode);
    expect(setup.body.success).toBe(true);
    const info = await getJoinInfo(ctx, setup.body.joinCode!);
    expect(info.data.maxPlayers).toBe(8);
    expect(info.data.schemas).toEqual([{ id: "generic", name: "Gamepad" }]);

    const driver = await WsClient.open(
      `?role=driver&token=${setup.body.driverToken}`,
      { label: "escape-driver" },
    );
    await driver.waitForType("snapshot");
    const join = await joinSession(ctx, setup.body.joinCode!);
    const player = await WsClient.open(
      `?role=player&token=${join.data.playerToken}`,
      { label: "escape-player" },
    );
    await player.waitForType("snapshot");

    // Leaving from the lobby frees the default name and color for the next
    // joiner — the slot really is gone, not just disconnected.
    const join2 = await joinSession(ctx, setup.body.joinCode!);
    const leaver = await WsClient.open(
      `?role=player&token=${join2.data.playerToken}`,
      { label: "escape-leaver" },
    );
    const leaverSnap = await leaver.waitForType("snapshot");
    const leaverInfo = (leaverSnap.snapshot as any).players.find(
      (p: any) => p.playerId === join2.data.playerId,
    );

    const pCursor = player.mark();
    leaver.send({ type: "leave" });
    expect((await leaver.waitForClose()).code).toBe(1000);
    await player.waitFor(
      (m) => m.type === "player_left" && m.playerId === join2.data.playerId,
      { after: pCursor },
    );

    const join3 = await joinSession(ctx, setup.body.joinCode!);
    expect(join3.error).toBeUndefined();
    const rejoined = await player.waitFor(
      (m) =>
        m.type === "player_joined" &&
        (m.player as any).playerId === join3.data.playerId,
      { after: pCursor },
    );
    expect((rejoined.player as any).name).toBe(leaverInfo.name);
    expect((rejoined.player as any).color).toBe(leaverInfo.color);

    const ended = await hostCall(ctx, "endMySession");
    expect(ended.data).toEqual({ success: true });
    for (const client of [driver, player]) {
      const change = await client.waitFor(
        (m) => m.type === "state_changed" && m.state === "ended",
      );
      expect(change.reason).toBe("host_ended");
      expect((await client.waitForClose()).code).toBe(4005);
    }
  });
});

test.describe("driver setup endpoint validation", () => {
  test("rejects malformed requests and unknown codes", async ({ request }) => {
    const missingCode = await request.post("/api/kapula/driver/setup", {
      headers: { "x-kapula-ratelimit-key": crypto.randomUUID() },
      data: {},
    });
    expect(missingCode.status()).toBe(400);
    const missingBody = await missingCode.json();
    expect(missingBody.success).toBe(false);
    expect(missingBody.issues?.length).toBeGreaterThan(0);

    const badConfig = await driverSetup(request, "ABC234", {
      minPlayers: 5,
      maxPlayers: 2,
    });
    expect(badConfig.status).toBe(400);
    expect(badConfig.body.issues?.join(" ")).toContain("minPlayers");

    const unknown = await driverSetup(request, "ZYXWVU");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain("setup code");
  });

  test("a driver may ask for a protocol version it can speak", async () => {
    const ctx = await newContext();
    try {
      await devLogin(ctx, uniqueEmail("kapula-version"));
      const created = await createHostSession(ctx);

      // A version this server does not serve is refused before the setup
      // code is looked up, with the list of what it does serve — so the code
      // survives the rejection and the driver can retry as version 1.
      const unsupported = await driverSetup(
        ctx,
        created.setupCode,
        undefined,
        undefined,
        99,
      );
      expect(unsupported.status).toBe(400);
      expect(unsupported.body.error).toContain("Unsupported protocol version");
      expect(unsupported.body.supported).toEqual([KAPULA_PROTOCOL_VERSION]);

      // Asking for the current version is the same as not asking.
      const ok = await driverSetup(
        ctx,
        created.setupCode,
        undefined,
        undefined,
        KAPULA_PROTOCOL_VERSION,
      );
      expect(ok.status).toBe(200);
      expect(ok.body.protocolVersion).toBe(KAPULA_PROTOCOL_VERSION);

      // ...and the version is in the snapshot too, for a driver that
      // reconnects without the setup response it once got. Connect through
      // the absolute wsUrl, the way a real driver does.
      const driver = await WsClient.open("", {
        url: ok.body.wsUrl,
        label: "driver-version",
      });
      try {
        const snap = await driver.waitForType("snapshot");
        expect((snap.snapshot as any).protocolVersion).toBe(
          KAPULA_PROTOCOL_VERSION,
        );
      } finally {
        driver.close();
      }
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe("wire contract", () => {
  test("every message the server sent matched kapulaServerMessageSchema", () => {
    for (const client of allClients) {
      expect
        .soft(client.invalidMessages, `invalid frames on [${client.label}]`)
        .toEqual([]);
    }
    // Guard against vacuity only loosely: a mid-file test failure makes
    // Playwright restart the worker process, which resets the registry.
    expect(allClients.length).toBeGreaterThan(0);
  });
});

// The burst deliberately fills ONE rate-limit bucket (a fixed key on the
// dev-only bucket header), so nothing else — this run's other tests, or the
// next run against the same live backend — is throttled by it. The window
// logic itself is unit-tested with a fake clock (createRateLimiter in
// logic.spec.ts).
test.describe("driver setup rate limiting", () => {
  test("the 11th call inside a minute is rejected with 429", async ({
    request,
  }) => {
    const bucket = `rate-limit-probe-${crypto.randomUUID()}`;
    // Concurrent burst: even on a slow stack all 12 calls land inside one
    // rate window, so at least two must be rejected.
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        driverSetup(request, "ZYXWVU", undefined, bucket).then(
          (r) => r.status,
        ),
      ),
    );
    expect(statuses).toContain(429);

    // The drained bucket is isolated: a caller in another bucket sails past
    // the limiter (404 = unknown code, i.e. the request was processed).
    const other = await driverSetup(request, "ZYXWVU");
    expect(other.status).toBe(404);
  });
});
