# @kapula/protocol

The Kapula wire protocol as code: zod schemas, constants and TypeScript types
for sessions, controls, the driver and player WebSocket messages and the HTTP
bodies. Phones act as controllers for a "driver" (a game or desktop app);
this package is what every side agrees on.

```ts
import { kapulaServerMessageSchema, KAPULA_PROTOCOL_VERSION } from "@kapula/protocol";

const msg = kapulaServerMessageSchema.parse(JSON.parse(frame));
if (msg.type === "input") console.log(msg.playerId, msg.controls);
```

Drivers written in TypeScript import it to parse what the server sends and
to type what they send. Everyone else reads the protocol document:
[docs/KAPULA.md](https://github.com/porrasm/kapula/blob/main/docs/KAPULA.md).

Protocol version 2 is pre-release until the first stable Kapula release.
Within a version changes are additive only; see the document for the rules
drivers can rely on. MIT.
