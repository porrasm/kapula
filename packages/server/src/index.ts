/**
 * `@kapula/server`: everything the Kapula protocol needs on the server side,
 * built over a host's store, auth and logger. Start with `createGamepadServer`;
 * `createMemoryGamepadStore` is a complete store for embedded hosts and tests.
 * See docs/KAPULA.md in the repository for the protocol and the design.
 */
export { createGamepadServer } from "./server.js";
export type { GamepadServer, GamepadServerDeps } from "./server.js";
export {
  GAMEPAD_DEFAULT_CONFIG,
  type GamepadAuth,
  type GamepadContext,
  type GamepadHostUser,
  type GamepadLogger,
  type GamepadServerConfig,
} from "./context.js";
export * from "./store.js";
export { createMemoryGamepadStore } from "./memory-store.js";
export {
  GamepadServiceError,
  createGamepadService,
  type GamepadMySession,
  type GamepadService,
  type GamepadServiceErrorCode,
} from "./service.js";
export { createHostRouter, GAMEPAD_HOST_OPERATIONS, type GamepadHostOperation } from "./host-api.js";
export { createPlayerRouter } from "./player-api.js";
export { createDriverRouter } from "./driver-api.js";
export * from "./logic.js";
