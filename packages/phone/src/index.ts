/**
 * `@kapula/phone`: the screens a player's phone needs, host-agnostic. Mount
 * `KapulaPlayerProvider` around them with the API base of your server, then
 * render `PlayerHome` on the landing route and `PlayerSession` once a
 * credential is stored. Styles: import `@kapula/phone/kapula.css` and add
 * `@kapula/phone/tailwind-preset` to your Tailwind config. Pure helpers that
 * run outside the browser (layout engine, debug presets…) are in
 * `@kapula/phone/utils`.
 */
export {
  KapulaPlayerProvider,
  KAPULA_PLAYER_DEFAULTS,
  buildGamepadWsUrl,
  useKapulaConfig,
  type KapulaPlayerConfig,
} from "./config.js";
export { createPlayerApi, usePlayerApi, type PlayerApi } from "./player-api.js";
export { PlayerHome, type PlayerHomeProps } from "./PlayerHome.js";
export { JoinScreen } from "./JoinScreen.js";
export { PlayerSession } from "./PlayerSession.js";
export { MissingRoster, PlayerList } from "./PlayerList.js";
export { Controller } from "./Controller.js";
export { OrientedSurface } from "./OrientedSurface.js";
export { PhysicalGamepadPreview } from "./PhysicalGamepadPanel.js";
export { useGamepadSocket, type GamepadSocket } from "./useGamepadSocket.js";
export { useNoPinchZoom } from "./useViewportGuard.js";
export { Badge, Button, Card, LoadingState } from "./ui.js";
export * from "./utils.js";
