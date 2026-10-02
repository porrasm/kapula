/**
 * `@kapula/phone/utils`: the pure modules behind the screens — layout
 * engine, gyro and motion math, snapshot folding, debug presets, stored
 * credentials. No React, no DOM at import time, so they run in Node (the
 * unit tests, a driver that wants the same layout math).
 */
export * from "./axis-utils.js";
export * from "./debug-utils.js";
export * from "./driver-payload.js";
export * from "./gyro-utils.js";
export * from "./layout-override.js";
export * from "./layout-utils.js";
export * from "./motion-utils.js";
export * from "./orientation-utils.js";
export * from "./physical-gamepad-utils.js";
export * from "./player-storage.js";
export * from "./pointer-utils.js";
export * from "./raw-touch-utils.js";
export * from "./safe-area.js";
export * from "./seq-counter.js";
export * from "./session-messages.js";
export * from "./snapshot-utils.js";
export { isTextEntry } from "./useViewportGuard.js";
