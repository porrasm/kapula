import { test, expect } from "@playwright/test";
import crypto from "crypto";
import {
  KapulaStoreConflictError,
  type KapulaStore,
} from "../store.js";

/**
 * The behaviour every `KapulaStore` implementation must share, as one spec
 * run against each of them: the in-memory store in the unit project, the
 * Postgres store in the e2e project (where a database is available). The
 * rules it checks are the ones in the contract's doc comment in store.ts;
 * when a rule changes, change it there, here, and in every store.
 *
 * Each test builds its own sessions with fresh random codes and tokens, so
 * the suite can run against a live database next to other data and repeat
 * runs never collide.
 */

export type KapulaStoreFixture = {
  store: KapulaStore;
  /** Two users that exist in the host's world (foreign keys, for Postgres). */
  ownerId: number;
  otherUserId: number;
  /**
   * Moves the store's clock forward. Only a store with an injectable clock
   * offers it; the time-rule tests are skipped without it.
   */
  advanceClock?: (ms: number) => void;
  /**
   * Whether the store holds nothing but this suite's data. The sweeping
   * operations (`markAllDriversDisconnected`, `endInactiveSessions`) touch
   * every live session, so against a shared database — the dev one, with
   * someone's game possibly running — their tests are skipped.
   */
  isolated: boolean;
  dispose?: () => Promise<void>;
};

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
const token = () => crypto.randomBytes(16).toString("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const expectConflict = async (run: () => Promise<unknown>) => {
  let error: unknown = null;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(KapulaStoreConflictError);
};

export const describeKapulaStoreConformance = (
  name: string,
  make: () => Promise<KapulaStoreFixture>,
) => {
  test.describe(`${name}: KapulaStore conformance`, () => {
    let f: KapulaStoreFixture;
    let store: KapulaStore;

    test.beforeAll(async () => {
      f = await make();
      store = f.store;
    });
    test.afterAll(async () => {
      await f?.dispose?.();
    });

    /** A session claimed by a driver: the state most tests start from. */
    const setUp = async (
      config: Record<string, unknown> = {},
      extra: { ownerId?: number; driverKeyId?: number | null } = {},
    ) => {
      const created = await store.createSession({
        ownerId: extra.ownerId ?? f.ownerId,
        setupCode: code(),
        metadata: null,
        driverKeyId: extra.driverKeyId ?? null,
      });
      const session = await store.setupSession({
        sessionId: created.id,
        joinCode: code(),
        driverToken: token(),
        config,
      });
      expect(session).not.toBeNull();
      return session!;
    };

    test.describe("sessions", () => {
      test("a created session is not initialized and findable by id and setup code", async () => {
        const setupCode = code();
        const created = await store.createSession({
          ownerId: f.ownerId,
          setupCode,
          metadata: "cfg=1",
        });
        expect(created).toMatchObject({
          ownerId: f.ownerId,
          state: "not_initialized",
          setupCode,
          joinCode: null,
          driverToken: null,
          config: null,
          metadata: "cfg=1",
          driverKeyId: null,
          driverAway: false,
        });
        expect(created.id).toMatch(/^\d+$/);
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(await store.getActiveSessionById(created.id)).toEqual(created);
        expect(await store.getActiveSessionBySetupCode(setupCode)).toEqual(created);
        await store.endSession(created.id);
      });

      test("setup codes are unique among active sessions and free again after the end", async () => {
        const setupCode = code();
        const first = await store.createSession({ ownerId: f.ownerId, setupCode, metadata: null });
        await expectConflict(() =>
          store.createSession({ ownerId: f.ownerId, setupCode, metadata: null }),
        );
        await store.endSession(first.id);
        const second = await store.createSession({ ownerId: f.ownerId, setupCode, metadata: null });
        expect(second.id).not.toBe(first.id);
        expect((await store.getActiveSessionBySetupCode(setupCode))?.id).toBe(second.id);
        await store.endSession(second.id);
      });

      test("setup consumes the code, opens the session and starts the driver-away clock", async () => {
        const created = await store.createSession({
          ownerId: f.ownerId,
          setupCode: code(),
          metadata: null,
        });
        const joinCode = code();
        const driverToken = token();
        const config = { game: "Test", maxPlayers: 4, nested: { a: [1, 2] }, gone: undefined };
        const session = await store.setupSession({
          sessionId: created.id,
          joinCode,
          driverToken,
          config,
        });
        expect(session).toMatchObject({
          id: created.id,
          state: "waiting_for_players",
          setupCode: null,
          joinCode,
          driverToken,
          driverAway: true,
        });
        // Stored as JSON: undefined keys vanish, structure survives.
        expect(session!.config).toEqual({ game: "Test", maxPlayers: 4, nested: { a: [1, 2] } });
        expect(await store.getActiveSessionByJoinCode(joinCode)).toEqual(session);
        expect(await store.getActiveSessionByDriverToken(driverToken)).toEqual(session);
        expect(await store.getActiveSessionBySetupCode(created.setupCode!)).toBeNull();
        // Only once: a second claim finds no not_initialized session.
        expect(
          await store.setupSession({
            sessionId: created.id,
            joinCode: code(),
            driverToken: token(),
            config,
          }),
        ).toBeNull();
        await store.endSession(created.id);
      });

      test("join codes are unique among active sessions", async () => {
        const a = await setUp();
        const b = await store.createSession({ ownerId: f.ownerId, setupCode: code(), metadata: null });
        await expectConflict(() =>
          store.setupSession({
            sessionId: b.id,
            joinCode: a.joinCode!,
            driverToken: token(),
            config: {},
          }),
        );
        await store.endSession(a.id);
        // Free again once the holder ended.
        const reused = await store.setupSession({
          sessionId: b.id,
          joinCode: a.joinCode!,
          driverToken: token(),
          config: {},
        });
        expect(reused?.joinCode).toBe(a.joinCode);
        await store.endSession(b.id);
      });

      test("an ended session is invisible to every lookup, and ends only once", async () => {
        const session = await setUp();
        const ended = await store.endSession(session.id);
        expect(ended).toMatchObject({ id: session.id, state: "ended" });
        expect(await store.endSession(session.id)).toBeNull();
        expect(await store.getActiveSessionById(session.id)).toBeNull();
        expect(await store.getActiveSessionByJoinCode(session.joinCode!)).toBeNull();
        expect(await store.getActiveSessionByDriverToken(session.driverToken!)).toBeNull();
        expect(await store.updateSessionState({ sessionId: session.id, state: "paused" })).toBeNull();
        expect(await store.getDriverAwayMs(session.id)).toBeNull();
      });

      test("state updates return the new record", async () => {
        const session = await setUp();
        const updated = await store.updateSessionState({
          sessionId: session.id,
          state: "in_progress",
        });
        expect(updated?.state).toBe("in_progress");
        expect((await store.getActiveSessionById(session.id))?.state).toBe("in_progress");
        await store.endSession(session.id);
      });

      test("the owner's sessions: one hosted slot, keyed sessions after it, in creation order", async () => {
        const ownerId = f.otherUserId;
        expect(await store.getActiveHostedSessionByOwner(ownerId)).toBeNull();
        const key = await store.insertDriverKey({
          userId: ownerId,
          name: "Key",
          hash: token(),
          prefix: "kpk_test",
          linkedEmails: [],
        });
        const keyed = await setUp({}, { ownerId, driverKeyId: key.id });
        const hosted = await setUp({}, { ownerId });
        expect((await store.getActiveHostedSessionByOwner(ownerId))?.id).toBe(hosted.id);
        expect((await store.getActiveSessionByDriverKey(key.id))?.id).toBe(keyed.id);
        expect((await store.getActiveSessionsByOwner(ownerId)).map((s) => s.id)).toEqual([
          hosted.id,
          keyed.id,
        ]);
        expect(await store.getActiveSessionsByOwner(f.ownerId)).not.toContainEqual(
          expect.objectContaining({ id: hosted.id }),
        );
        await store.endSession(hosted.id);
        await store.endSession(keyed.id);
        expect(await store.getActiveSessionByDriverKey(key.id)).toBeNull();
        expect(await store.getActiveSessionsByOwner(ownerId)).toEqual([]);
        await store.revokeDriverKey({ keyId: key.id, userId: ownerId });
      });
    });

    test.describe("driver-away clock", () => {
      test("connect clears it, disconnect starts it once, and it is measured by the store", async () => {
        const session = await setUp();
        expect(await store.getDriverAwayMs(session.id)).toBeGreaterThanOrEqual(0);
        await store.markDriverConnected(session.id);
        expect(await store.getDriverAwayMs(session.id)).toBeNull();
        expect((await store.getActiveSessionById(session.id))?.driverAway).toBe(false);

        await store.markDriverDisconnected(session.id);
        if (f.advanceClock) f.advanceClock(500);
        else await sleep(40);
        const away = await store.getDriverAwayMs(session.id);
        expect(away).toBeGreaterThanOrEqual(f.advanceClock ? 500 : 20);
        // A second disconnect keeps the earlier start.
        await store.markDriverDisconnected(session.id);
        expect(await store.getDriverAwayMs(session.id)).toBeGreaterThanOrEqual(away!);
        expect((await store.getActiveSessionById(session.id))?.driverAway).toBe(true);
        await store.endSession(session.id);
      });

      test("a restart marks every initialized session with a driver as driver-less", async () => {
        test.skip(!f.isolated, "sweeps every live session: isolated stores only");
        const connected = await setUp();
        await store.markDriverConnected(connected.id);
        const unclaimed = await store.createSession({
          ownerId: f.ownerId,
          setupCode: code(),
          metadata: null,
        });
        const count = await store.markAllDriversDisconnected();
        expect(count).toBeGreaterThanOrEqual(1);
        expect((await store.getActiveSessionById(connected.id))?.driverAway).toBe(true);
        expect((await store.getActiveSessionById(unclaimed.id))?.driverAway).toBe(false);
        await store.endSession(connected.id);
        await store.endSession(unclaimed.id);
      });

      test("the cleanup ends sessions whose driver stayed away, reporting driver_lost", async () => {
        test.skip(!f.isolated, "sweeps every live session: isolated stores only");
        const lost = await setUp();
        const alive = await setUp();
        await store.markDriverConnected(alive.id);
        if (f.advanceClock) f.advanceClock(100);
        else await sleep(30);
        const ended = await store.endInactiveSessions({ driverLostMs: 10 });
        expect(ended).toContainEqual({ sessionId: lost.id, driverLost: true });
        expect(ended).not.toContainEqual(expect.objectContaining({ sessionId: alive.id }));
        expect(await store.getActiveSessionById(lost.id)).toBeNull();
        expect(await store.getActiveSessionById(alive.id)).not.toBeNull();
        await store.endSession(alive.id);
      });

      test("the cleanup ends idle sessions and unclaimed ones faster", async () => {
        test.skip(!f.advanceClock || !f.isolated, "needs an injectable clock and an isolated store");
        const idle = await setUp();
        await store.markDriverConnected(idle.id);
        const unclaimed = await store.createSession({
          ownerId: f.ownerId,
          setupCode: code(),
          metadata: null,
        });
        f.advanceClock!(31 * 60 * 1000);
        let ended = await store.endInactiveSessions({ driverLostMs: 60_000 });
        expect(ended).toContainEqual({ sessionId: unclaimed.id, driverLost: false });
        expect(ended).not.toContainEqual(expect.objectContaining({ sessionId: idle.id }));
        // Activity resets the idle clock.
        f.advanceClock!(23 * 60 * 60 * 1000);
        await store.touchSessionActivity(idle.id);
        f.advanceClock!(2 * 60 * 60 * 1000);
        ended = await store.endInactiveSessions({ driverLostMs: 60_000 });
        expect(ended).not.toContainEqual(expect.objectContaining({ sessionId: idle.id }));
        f.advanceClock!(23 * 60 * 60 * 1000);
        ended = await store.endInactiveSessions({ driverLostMs: 60_000 });
        expect(ended).toContainEqual({ sessionId: idle.id, driverLost: false });
      });
    });

    test.describe("players", () => {
      test("join, list in join order, find by token", async () => {
        const session = await setUp();
        const a = await store.insertPlayer({
          sessionId: session.id,
          name: "Ann",
          color: "#111111",
          token: token(),
          schemaId: "s",
        });
        const b = await store.insertPlayer({
          sessionId: session.id,
          name: "Bob",
          color: "#222222",
          token: token(),
          schemaId: "s",
        });
        expect(a).toMatchObject({ sessionId: session.id, name: "Ann", ready: false, schemaId: "s" });
        expect(a.id).toMatch(/^\d+$/);
        expect((await store.getActivePlayersBySession(session.id)).map((p) => p.id)).toEqual([
          a.id,
          b.id,
        ]);
        expect(await store.getActivePlayerByToken(b.token)).toEqual(b);
        expect(await store.getActivePlayerByToken(token())).toBeNull();
        await store.endSession(session.id);
      });

      test("names (case-insensitive), colors and tokens are unique among active players", async () => {
        const session = await setUp();
        const other = await setUp();
        const base = { sessionId: session.id, schemaId: "s" };
        const a = await store.insertPlayer({ ...base, name: "Ann", color: "#111111", token: token() });
        await expectConflict(() =>
          store.insertPlayer({ ...base, name: "ANN", color: "#333333", token: token() }),
        );
        await expectConflict(() =>
          store.insertPlayer({ ...base, name: "Cid", color: "#111111", token: token() }),
        );
        await expectConflict(() =>
          store.insertPlayer({ ...base, name: "Cid", color: "#333333", token: a.token }),
        );
        // Another session is another namespace for names and colors.
        const twin = await store.insertPlayer({
          sessionId: other.id,
          name: "Ann",
          color: "#111111",
          token: token(),
          schemaId: "s",
        });
        expect(twin.name).toBe("Ann");
        await store.endSession(session.id);
        await store.endSession(other.id);
      });

      test("leaving frees the name and color, kills the token, and happens once", async () => {
        const session = await setUp();
        const base = { sessionId: session.id, schemaId: "s" };
        const a = await store.insertPlayer({ ...base, name: "Ann", color: "#111111", token: token() });
        expect((await store.markPlayerLeft(a.id))?.id).toBe(a.id);
        expect(await store.markPlayerLeft(a.id)).toBeNull();
        expect(await store.getActivePlayerByToken(a.token)).toBeNull();
        expect(await store.getActivePlayersBySession(session.id)).toEqual([]);
        expect(await store.updatePlayerReady({ playerId: a.id, ready: true })).toBeNull();
        const again = await store.insertPlayer({ ...base, name: "ann", color: "#111111", token: token() });
        expect(again.id).not.toBe(a.id);
        await store.endSession(session.id);
      });

      test("ready, profile and schema updates; profile changes respect the other players", async () => {
        const session = await setUp();
        const base = { sessionId: session.id, schemaId: "s" };
        const a = await store.insertPlayer({ ...base, name: "Ann", color: "#111111", token: token() });
        const b = await store.insertPlayer({ ...base, name: "Bob", color: "#222222", token: token() });
        expect((await store.updatePlayerReady({ playerId: a.id, ready: true }))?.ready).toBe(true);
        expect((await store.updatePlayerSchema({ playerId: a.id, schemaId: "t" }))?.schemaId).toBe("t");
        const renamed = await store.updatePlayerProfile({
          playerId: a.id,
          name: "Anne",
          color: "#333333",
        });
        expect(renamed).toMatchObject({ id: a.id, name: "Anne", color: "#333333", ready: true });
        // Keeping one's own name and color is not a conflict.
        expect(
          (await store.updatePlayerProfile({ playerId: a.id, name: "anne", color: "#333333" }))?.name,
        ).toBe("anne");
        await expectConflict(() =>
          store.updatePlayerProfile({ playerId: a.id, name: "BOB", color: "#333333" }),
        );
        await expectConflict(() =>
          store.updatePlayerProfile({ playerId: a.id, name: "Anne", color: "#222222" }),
        );
        expect((await store.getActivePlayersBySession(session.id)).find((p) => p.id === b.id)).toEqual(b);
        await store.endSession(session.id);
      });

      test("clearing ready returns only the players that were ready", async () => {
        const session = await setUp();
        const base = { sessionId: session.id, schemaId: "s" };
        const a = await store.insertPlayer({ ...base, name: "Ann", color: "#111111", token: token() });
        const b = await store.insertPlayer({ ...base, name: "Bob", color: "#222222", token: token() });
        await store.updatePlayerReady({ playerId: a.id, ready: true });
        const cleared = await store.clearReadyBySession(session.id);
        expect(cleared.map((p) => p.id)).toEqual([a.id]);
        expect(cleared[0].ready).toBe(false);
        expect(await store.clearReadyBySession(session.id)).toEqual([]);
        expect((await store.getActivePlayersBySession(session.id)).map((p) => p.ready)).toEqual([
          false,
          false,
        ]);
        void b;
        await store.endSession(session.id);
      });
    });

    test.describe("driver keys", () => {
      test("create, list newest first, look up live keys by hash, mark used", async () => {
        const userId = f.ownerId;
        const hash = token();
        const first = await store.insertDriverKey({
          userId,
          name: "First",
          hash,
          prefix: "kpk_aaaa",
          linkedEmails: ["a@example.com"],
        });
        expect(first).toMatchObject({
          userId,
          name: "First",
          prefix: "kpk_aaaa",
          linkedEmails: ["a@example.com"],
          lastUsedAt: null,
        });
        expect(first.createdAt).toBeInstanceOf(Date);
        if (f.advanceClock) f.advanceClock(10);
        else await sleep(5);
        const second = await store.insertDriverKey({
          userId,
          name: "Second",
          hash: token(),
          prefix: "kpk_bbbb",
          linkedEmails: [],
        });
        const listed = (await store.getDriverKeysByUser(userId)).map((k) => k.id);
        expect(listed.indexOf(second.id)).toBeLessThan(listed.indexOf(first.id));
        expect(await store.getLiveDriverKeyByHash(hash)).toEqual(first);
        await expectConflict(() =>
          store.insertDriverKey({ userId, name: "Dup", hash, prefix: "kpk_cccc", linkedEmails: [] }),
        );
        await store.touchDriverKeyUsed(first.id);
        expect((await store.getLiveDriverKeyByHash(hash))?.lastUsedAt).toBeInstanceOf(Date);
        await store.revokeDriverKey({ keyId: first.id, userId });
        await store.revokeDriverKey({ keyId: second.id, userId });
      });

      test("linked emails and revocation are owner-scoped; a revoked key is gone", async () => {
        const hash = token();
        const key = await store.insertDriverKey({
          userId: f.ownerId,
          name: "Mine",
          hash,
          prefix: "kpk_dddd",
          linkedEmails: [],
        });
        expect(
          await store.setDriverKeyLinkedEmails({
            keyId: key.id,
            userId: f.otherUserId,
            linkedEmails: ["x@example.com"],
          }),
        ).toBeNull();
        expect(
          (
            await store.setDriverKeyLinkedEmails({
              keyId: key.id,
              userId: f.ownerId,
              linkedEmails: ["x@example.com"],
            })
          )?.linkedEmails,
        ).toEqual(["x@example.com"]);
        expect(await store.revokeDriverKey({ keyId: key.id, userId: f.otherUserId })).toBe(false);
        expect(await store.revokeDriverKey({ keyId: key.id, userId: f.ownerId })).toBe(true);
        expect(await store.revokeDriverKey({ keyId: key.id, userId: f.ownerId })).toBe(false);
        expect(await store.getLiveDriverKeyByHash(hash)).toBeNull();
        expect(await store.getDriverKeysByUser(f.ownerId)).not.toContainEqual(
          expect.objectContaining({ id: key.id }),
        );
        expect(
          await store.setDriverKeyLinkedEmails({ keyId: key.id, userId: f.ownerId, linkedEmails: [] }),
        ).toBeNull();
      });
    });

    test.describe("private sessions", () => {
      test("the owner and the key's linked emails see a private keyed session, named after the key", async () => {
        const email = `${token()}@example.com`;
        const key = await store.insertDriverKey({
          userId: f.ownerId,
          name: "Living room",
          hash: token(),
          prefix: "kpk_eeee",
          linkedEmails: [email],
        });
        const session = await setUp({ private: true }, { driverKeyId: key.id });
        const publicOne = await setUp({ private: false });
        const unclaimed = await store.createSession({
          ownerId: f.ownerId,
          setupCode: code(),
          metadata: null,
        });

        const forOwner = await store.getPrivateSessionsForUser({
          userId: f.ownerId,
          email: "owner@example.com",
        });
        expect(forOwner.map((s) => s.id)).toContain(session.id);
        expect(forOwner.map((s) => s.id)).not.toContain(publicOne.id);
        expect(forOwner.map((s) => s.id)).not.toContain(unclaimed.id);
        expect(forOwner.find((s) => s.id === session.id)?.keyName).toBe("Living room");

        const forLinked = await store.getPrivateSessionsForUser({
          userId: f.otherUserId,
          email,
        });
        expect(forLinked.map((s) => s.id)).toEqual([session.id]);
        expect(
          await store.getPrivateSessionsForUser({ userId: f.otherUserId, email: "nobody@example.com" }),
        ).toEqual([]);
        // Narrowed to one session, for the access check at join.
        expect(
          (await store.getPrivateSessionsForUser({ userId: f.otherUserId, email, sessionId: session.id }))
            .length,
        ).toBe(1);
        expect(
          await store.getPrivateSessionsForUser({ userId: f.otherUserId, email, sessionId: publicOne.id }),
        ).toEqual([]);

        // Unlinking, or revoking the key, closes the door; the owner keeps it.
        await store.setDriverKeyLinkedEmails({ keyId: key.id, userId: f.ownerId, linkedEmails: [] });
        expect(await store.getPrivateSessionsForUser({ userId: f.otherUserId, email })).toEqual([]);
        await store.setDriverKeyLinkedEmails({ keyId: key.id, userId: f.ownerId, linkedEmails: [email] });
        await store.revokeDriverKey({ keyId: key.id, userId: f.ownerId });
        expect(await store.getPrivateSessionsForUser({ userId: f.otherUserId, email })).toEqual([]);
        expect(
          (await store.getPrivateSessionsForUser({ userId: f.ownerId, email: "owner@example.com" })).map(
            (s) => s.id,
          ),
        ).toContain(session.id);

        await store.endSession(session.id);
        await store.endSession(publicOne.id);
        await store.endSession(unclaimed.id);
        expect(
          (await store.getPrivateSessionsForUser({ userId: f.ownerId, email: "owner@example.com" })).map(
            (s) => s.id,
          ),
        ).not.toContain(session.id);
      });

      test("a private hosted session has no key name and only its owner", async () => {
        const session = await setUp({ private: true });
        const forOwner = await store.getPrivateSessionsForUser({
          userId: f.ownerId,
          email: "owner@example.com",
        });
        expect(forOwner.find((s) => s.id === session.id)?.keyName).toBeNull();
        expect(
          await store.getPrivateSessionsForUser({ userId: f.otherUserId, email: "owner@example.com" }),
        ).not.toContainEqual(expect.objectContaining({ id: session.id }));
        await store.endSession(session.id);
      });
    });

    test.describe("background images", () => {
      test("one image per session: upload, replace, serve by key, delete", async () => {
        const session = await setUp();
        expect(await store.getSessionBackgroundMeta(session.id)).toBeNull();
        const first = await store.upsertSessionBackground({
          sessionId: session.id,
          key: token(),
          contentType: "image/png",
          fit: "cover",
          data: "AAAA",
        });
        expect(await store.getSessionBackgroundMeta(session.id)).toEqual(first);
        expect(await store.getLiveBackgroundByKey(first.key)).toEqual({
          contentType: "image/png",
          data: "AAAA",
        });
        const second = await store.upsertSessionBackground({
          sessionId: session.id,
          key: token(),
          contentType: "image/jpeg",
          fit: "fill",
          data: "BBBB",
        });
        expect(second.fit).toBe("fill");
        expect(await store.getSessionBackgroundMeta(session.id)).toEqual(second);
        expect(await store.getLiveBackgroundByKey(first.key)).toBeNull();
        expect(await store.getLiveBackgroundByKey(second.key)).toEqual({
          contentType: "image/jpeg",
          data: "BBBB",
        });
        expect(await store.deleteSessionBackground(session.id)).toEqual(second);
        expect(await store.deleteSessionBackground(session.id)).toBeNull();
        expect(await store.getLiveBackgroundByKey(second.key)).toBeNull();
        await store.endSession(session.id);
      });

      test("an ended session's image stops serving and is swept by the cleanup", async () => {
        const session = await setUp();
        const meta = await store.upsertSessionBackground({
          sessionId: session.id,
          key: token(),
          contentType: "image/png",
          fit: "cover",
          data: "CCCC",
        });
        await store.endSession(session.id);
        expect(await store.getLiveBackgroundByKey(meta.key)).toBeNull();
        expect(await store.deleteEndedSessionBackgrounds()).toBeGreaterThanOrEqual(1);
        expect(await store.getSessionBackgroundMeta(session.id)).toBeNull();
        expect(await store.deleteEndedSessionBackgrounds()).toBe(0);
      });
    });
  });
};
