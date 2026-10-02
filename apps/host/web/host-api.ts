import type { KapulaHostOperation } from "@kapula/server";

/**
 * The host page's client for `POST /api/kapula/host/<op>` (see
 * @kapula/server host-api.ts): the payload on success, an Error carrying
 * the server's message otherwise.
 */
export const API_BASE = "/api/kapula";

export const hostCall = async <T = unknown>(
  op: KapulaHostOperation,
  input?: unknown,
): Promise<T> => {
  const res = await fetch(`${API_BASE}/host/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!body.success) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body.data as T;
};

export type Me = {
  user: { email: string } | null;
  devAuth: boolean;
  ownerLogin: boolean;
};

export const fetchMe = async (): Promise<Me> => {
  const res = await fetch("/auth/me");
  return (await res.json()) as Me;
};

export const loginWithToken = async (token: string): Promise<void> => {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error("Wrong token");
};

export const logout = () => fetch("/auth/logout", { method: "POST" });
