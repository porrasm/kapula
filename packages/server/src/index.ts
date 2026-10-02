/**
 * `@kapula/server`: everything the Kapula protocol needs on the server side,
 * built over a host's store, auth and logger. Start with `createKapulaServer`;
 * `createKapulaMemoryStore` is a complete store for embedded hosts and tests.
 * See docs/KAPULA.md in the repository for the protocol and the design.
 */
export { createKapulaServer } from "./server.js";
export type { KapulaServer, KapulaServerDeps } from "./server.js";
export {
  KAPULA_DEFAULT_CONFIG,
  type KapulaAuth,
  type KapulaContext,
  type KapulaHostUser,
  type KapulaLogger,
  type KapulaServerConfig,
} from "./context.js";
export * from "./store.js";
export { createKapulaMemoryStore } from "./memory-store.js";
export {
  KapulaServiceError,
  createKapulaService,
  type KapulaMySession,
  type KapulaService,
  type KapulaServiceErrorCode,
} from "./service.js";
export { createHostRouter, KAPULA_HOST_OPERATIONS, type KapulaHostOperation } from "./host-api.js";
export { createPlayerRouter } from "./player-api.js";
export { createDriverRouter } from "./driver-api.js";
export * from "./logic.js";
