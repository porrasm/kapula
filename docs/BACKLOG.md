# Kapula backlog

What is next, in order. The history of the gamepad app before the extraction
(GP-1…GP-31) stays in the monorepo's `backend/src/apps/gamepad/BACKLOG.md`.

## Extraction follow-ups (before the first publish)

1. **Browser e2e in CI.** `tests/e2e/browser.spec.ts` was ported from the
   monorepo (12 of its 15 tests; the debug-driver and help-page tests test
   monorepo pages) but has not run yet — the session that did the port could
   not launch Chromium. First green CI run is the gate.
2. **Rename.** Protocol version 1 is unlocked until the first stable release
   (see KAPULA.md "Protocol version 1 — pre-release"). Decide the public names
   while nobody depends on the packages: the API base (`/api/gamepad` →
   `/api/kapula`?), the `x-gamepad-ratelimit-key` header, the `GAMEPAD_*`
   environment variables and exports, the `Gamepad*` identifiers, the
   `gpk_` key prefix. One protocol version bump marks the new wire. Update
   KAPULA.md, the host and the monorepo's adoption notes together.
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
