# @kapula/server

The Kapula server core: sessions, driver/player/host WebSocket signaling and
the driver, player and host JSON APIs, built over a store you supply. Mount
it in any Node host — a web backend with a database, or a desktop app with
the included in-memory store.

```ts
import express from "express";
import http from "node:http";
import { createKapulaServer, createKapulaMemoryStore } from "@kapula/server";

const kapula = createKapulaServer({
  store: createKapulaMemoryStore(),
  auth: { getUserFromRequest: async () => ({ id: 1, email: "owner@localhost" }) },
  logger: console,
});

const app = express();
app.use(kapula.config.basePath, kapula.httpRouter); // /api/kapula
const server = http.createServer(app);
kapula.attachWebSocket(server);
setInterval(() => kapula.runCleanup(), 60_000);
server.listen(4310);
```

- `store`: a `KapulaStore` (`createKapulaMemoryStore()` for one process; implement
  the interface over your database for anything durable and run the
  conformance suite from `@kapula/server/testing` against it).
- `auth`: who the logged-in user behind a request is — only the host page and
  the host API need it; drivers and players hold their own tokens.
- `config`: base path, player app path, timeouts; see `KAPULA_DEFAULT_CONFIG`.

The reference host in the repository (`apps/host`) is a complete example,
and [docs/KAPULA.md](https://github.com/porrasm/kapula/blob/main/docs/KAPULA.md)
describes the protocol and the design. MIT.
