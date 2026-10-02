import { useMemo } from "react";
import type {
  KapulaJoinInfo,
  KapulaJoinRequest,
  KapulaJoinResult,
  KapulaPlayerStatus,
} from "@kapula/protocol";
import { useKapulaConfig } from "./config.js";

/**
 * The phone's HTTP surface: three JSON routes under the Kapula API base
 * (see KAPULA.md "Player HTTP API"). Plain fetch, no account — so the
 * player screens work wherever the server is hosted; the base comes from
 * the host's `KapulaPlayerConfig`.
 */

type Failure = { success: false; error: string };

/** Parses a response; a failure body (or a non-JSON one) becomes an Error. */
const unwrap = async <T>(res: Response): Promise<T> => {
  let body: (T & { success: true }) | Failure;
  try {
    body = (await res.json()) as (T & { success: true }) | Failure;
  } catch {
    throw new Error(`Request failed (${res.status})`);
  }
  if (!body.success) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
};

export type PlayerApi = {
  fetchJoinInfo: (joinCode: string) => Promise<KapulaJoinInfo | null>;
  joinSession: (request: KapulaJoinRequest) => Promise<KapulaJoinResult>;
  fetchPlayerStatus: (token: string) => Promise<KapulaPlayerStatus | null>;
};

export const createPlayerApi = (apiBase: string): PlayerApi => {
  const postJson = (path: string, body: unknown) =>
    fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    fetchJoinInfo: async (joinCode) => {
      const res = await fetch(
        `${apiBase}/join-info/${encodeURIComponent(joinCode)}`,
      );
      return (await unwrap<{ info: KapulaJoinInfo | null }>(res)).info;
    },
    joinSession: async (request) => {
      const res = await postJson("/join", request);
      const { sessionId, playerId, playerToken } =
        await unwrap<KapulaJoinResult>(res);
      return { sessionId, playerId, playerToken };
    },
    fetchPlayerStatus: async (token) => {
      const res = await postJson("/player/status", { token });
      return (await unwrap<{ status: KapulaPlayerStatus | null }>(res)).status;
    },
  };
};

/** The client for the API base the host configured. */
export const usePlayerApi = (): PlayerApi => {
  const { apiBase } = useKapulaConfig();
  return useMemo(() => createPlayerApi(apiBase), [apiBase]);
};
