/**
 * Everything the reference host reads from its environment. Tests and the
 * Playwright config set the timing overrides; production leaves them unset.
 */
export type HostConfig = {
  port: number;
  production: boolean;
  /** Anyone may log in as any email — development and tests only. */
  devAuth: boolean;
  /** A single owner identified by this token; unset means no owner login. */
  ownerToken: string | null;
  ownerEmail: string;
  driverLostTimeoutMs: number | undefined;
  keepaliveIntervalMs: number | undefined;
};

const positive = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
};

export const readConfig = (env: NodeJS.ProcessEnv): HostConfig => ({
  port: positive(env.PORT) ?? 4310,
  production: env.NODE_ENV === "production",
  devAuth: env.KAPULA_DEV_AUTH === "1",
  ownerToken: env.KAPULA_OWNER_TOKEN || null,
  ownerEmail: (env.KAPULA_OWNER_EMAIL || "owner@localhost").toLowerCase(),
  driverLostTimeoutMs: positive(env.GAMEPAD_DRIVER_LOST_TIMEOUT_MS),
  keepaliveIntervalMs: positive(env.GAMEPAD_WS_KEEPALIVE_MS),
});
