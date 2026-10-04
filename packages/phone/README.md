# @kapula/phone

The React screens a player's phone needs to join a Kapula session and play:
join form, lobby, controller (touch sticks, buttons, d-pads, gyro, touchpad,
text), layout editor, physical-gamepad bridge. Host-agnostic: tell it where
the API is and render the screens in your own routes.

```tsx
import { KapulaPlayerProvider, PlayerHome, PlayerSession, loadStoredPlayer } from "@kapula/phone";
import "@kapula/phone/kapula.css";

<KapulaPlayerProvider config={{ apiBase: "/api/kapula" }}>
  {player ? <PlayerSession player={player} onLeave={...} /> : <PlayerHome ... />}
</KapulaPlayerProvider>
```

The one-liner, with [wouter](https://github.com/molefrog/wouter) routing:

```tsx
<KapulaPlayerProvider config={{ apiBase: "/api/kapula" }}>
  <PhoneApp title="Kapula" header={<UserBadge />} landingExtra={<HostPanel />} />
</KapulaPlayerProvider>
```

`PhoneApp` renders `/` (`PlayerHome` plus the optional `landingExtra`),
`/join/:code` (prefilled join form) and `/play` (`PlayerSession`), keeps the
stored player and handles leave and stale credentials. It needs `wouter` and
`@tanstack/react-query` in the app (`wouter` is an optional peer dependency:
only required if you use `PhoneApp`).

Styling: the screens use `kp-*` Tailwind utilities. Add
`@kapula/phone/tailwind-preset` to your Tailwind config's `presets` and the
package's `dist/**/*.js` to its `content`; the colors are CSS variables in
`kapula.css`, so a host re-themes by redefining them. Peer dependencies:
react, react-dom, @tanstack/react-query.

`@kapula/phone/utils` exposes the pure helpers (layout engine, gyro math,
snapshot folding) for Node and for drivers. The reference host in the
repository (`apps/host/web`) shows the complete wiring. MIT.
