import { defineConfig } from "@playwright/test";

/**
 * PW_HOST_URL points a run at a Kapula host that is already up (any origin
 * serving the API and the phone app); by default the e2e project boots the
 * reference host from apps/host on a spare port.
 */
export const HOST_PORT = Number(process.env.PW_HOST_PORT ?? 4310);
export const HOST_URL = process.env.PW_HOST_URL ?? `http://localhost:${HOST_PORT}`;

/**
 * Timings the e2e suite needs shorter than the production defaults; the
 * host reads the same variables (apps/host/src/config.ts), so one process
 * environment configures both sides.
 */
const E2E_ENV = {
  GAMEPAD_DRIVER_LOST_TIMEOUT_MS: process.env.GAMEPAD_DRIVER_LOST_TIMEOUT_MS ?? "6000",
  GAMEPAD_WS_KEEPALIVE_MS: process.env.GAMEPAD_WS_KEEPALIVE_MS ?? "2000",
};
Object.assign(process.env, E2E_ENV);

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  // The e2e specs share one host and its rate limits; keep them sequential.
  fullyParallel: false,
  workers: process.env.PW_E2E ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [
    { name: "unit", testDir: "tests/unit" },
    {
      name: "e2e",
      testDir: "tests/e2e",
      use: { baseURL: HOST_URL },
    },
  ],
  webServer:
    process.env.PW_E2E && !process.env.PW_HOST_URL
      ? {
          command: `npm run dev --workspace=apps/host`,
          url: `${HOST_URL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 90_000,
          env: { ...E2E_ENV, PORT: String(HOST_PORT), KAPULA_DEV_AUTH: "1" },
        }
      : undefined,
});
