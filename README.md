# Kapula

Checkout the example app: gamepad.porras.club

Phones as controllers for any game or desktop app. A game (the **driver**)
claims a session over a small HTTP API, players open a web page on their
phones and join with a code, and from then on every touch, tilt and button
reaches the driver over one WebSocket. The protocol, the server and the
phone UI are published as packages; this repository also holds a reference
host that runs them, and every test.

| Package | What it is |
| --- | --- |
| `@kapula/protocol` | The wire protocol: zod schemas, constants and types. Drivers written in TypeScript import it; everyone else reads `docs/KAPULA.md`. |
| `@kapula/server` | The server core: sessions, signaling, the driver/player/host JSON APIs — over a `KapulaStore` you implement (an in-memory store is included). `@kapula/server/testing` is the store conformance suite. |
| `@kapula/phone` | The React screens a phone needs: join, lobby, controller, layout editor. Host-agnostic: tell it where the API is. |
| `apps/host` | The reference host: the server over the memory store, the phone app, a minimal host page. Development, tests, and single-owner self-hosting. |

## Develop

```sh
npm install
npm run dev          # builds the packages, starts the reference host on http://localhost:4310
```

Set `KAPULA_DEV_AUTH=1` to log in as any email on the host page (never on a
public server). The driver API, the WebSocket and the phone app need no
account.

## Test

```sh
npm run test:unit    # protocol, logic, store conformance, layout math — no browser, no server
npm run test:e2e     # boots the reference host; the WebSocket protocol, CORS and the phone UI in Chromium
npm run typecheck
```

`npm run test:e2e` needs Chromium once: `npx playwright install --with-deps chromium`.
To run the e2e suites against a host you started yourself, set `PW_HOST_URL`.
CI runs all of this on every push (`.github/workflows/ci.yml`).

## Self-host

```sh
docker build -t kapula .
docker run -p 4310:4310 -e KAPULA_OWNER_TOKEN=change-me kapula
```

The owner logs in with the token to create sessions; sessions live in
memory and end with the process. For anything beyond one owner, implement
`KapulaStore` and `KapulaAuth` over your own database and users (see
`docs/KAPULA.md`, "Implementation map") and run the conformance suite
against your store.

## Release

The three packages ship together, one version, pinned to each other exactly.
After `npm login` (the `@kapula` scope):

```sh
node scripts/release.mjs 0.1.0-alpha.1 next --dry-run   # builds, tests, packs, publishes nothing
node scripts/release.mjs 0.1.0-alpha.1 next             # pre-release under the "next" tag
node scripts/release.mjs 0.1.0 latest                   # stable
git push && git push --tags
```

Consumers install a pre-release with `npm install @kapula/server@next`.

## Documents

- `docs/KAPULA.md` — the design and the protocol, section by section.
- `docs/BACKLOG.md` — what is next.

## License

MIT.
