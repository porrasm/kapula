# Dependency audit

Reviewed 2026-10-05 (`npm audit`). Updates are proposed weekly by `.github/dependabot.yml`; it does not replace this review for major upgrades.

## Resolved
- Vite 5 → 7 (`apps/host`): cleared the vite and esbuild advisories (dev-server path traversal / fs.deny bypass / cross-origin reads). They affected only `npm run dev`; the built host never ships Vite.

## Accepted: Tailwind 3 chain (5 high: tailwindcss, chokidar, fast-glob, micromatch, braces)
- Advisory: braces stack exhaustion on deeply nested glob patterns (GHSA-vfj7-8cjw-p6xm). No patched `braces` exists in this chain.
- Exposure: build time only. The patterns are our own `content` globs in the Tailwind config, never user input, and nothing from this chain runs in the host or phone at runtime.
- Fix is Tailwind 4, a major migration (config format, preset shipped as `@kapula/phone/tailwind-preset`). Do it as its own ticket, not as an audit fix.
