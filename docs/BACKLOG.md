# Kapula backlog

What is next, in order. The history of the gamepad app before the extraction
(GP-1…GP-31) stays in the monorepo's `backend/src/apps/gamepad/BACKLOG.md`.

## Extraction follow-ups (before the first publish)

1. **Browser e2e in CI.** `tests/e2e/browser.spec.ts` was ported from the
   monorepo (12 of its 15 tests; the debug-driver and help-page tests test
   monorepo pages) but has not run yet — the session that did the port could
   not launch Chromium. First green CI run is the gate.
2. **Rename — done 2026-10-02.** Identifiers carry a Kapula prefix, the wire
   is `/api/kapula` + `x-kapula-ratelimit-key` + `kpk_`, protocol version 2.
   Left as they were: the `Gamepad*` names of the physical-controller bridge
   (correct), and the monorepo, which keeps serving version 1 under
   `/api/gamepad` until it adopts the packages. Tell the one external driver
   author before that switch.
3. **Driver package.** `@kapula/driver`: a typed client for drivers (setup /
   create, the WebSocket with reconnect and the snapshot-authoritative
   rules), grown from `tests/e2e/test-driver.ts`. Nuppi and the e2e suite
   are its first users.
4. **Host page parity.** The reference host's page creates and watches
   sessions; driver-key management (create, link emails, revoke) exists only
   through the host API for now. Port the monorepo's `DriverKeys` panel.
5. **Phone app shell.** `PlayerHome` + `PlayerSession` + the three routes
   are wired by hand in `apps/host/web/App.tsx`; a `PhoneApp` component in
   `@kapula/phone` (with wouter as a peer) would make the next host a
   one-liner.
6. **Publish.** npm org, `publishConfig`, changesets or a release script,
   versions pinned together. Then the monorepo adopts the packages (its own
   plan: new `kapula` app consuming them, Postgres adapter kept, old code
   removed).

## Later

- Lint (typescript-eslint, react-hooks) in CI; the monorepo's config did not
  carry over.
- A persistent store for the reference host (SQLite) so a self-hosted
  instance survives restarts.
- Everything in the monorepo backlog's "Milestone C" that is still open
  (WebRTC data channel, live keystroke stream, …).
