import { useMemo } from "react";
import type {
  GamepadJoinInfo,
  GamepadJoinRequest,
  GamepadJoinResult,
  GamepadPlayerStatus,
} from "@kapula/protocol";
import { useKapulaConfig } from "./config.js";

/**
 * The phone's HTTP surface: three JSON routes under the Kapula API base
 * (see GAMEPAD.md "Player HTTP API"). Plain fetch, no account — so the
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
  fetchJoinInfo: (joinCode: string) => Promise<GamepadJoinInfo | null>;
  joinSession: (request: GamepadJoinRequest) => Promise<GamepadJoinResult>;
  fetchPlayerStatus: (token: string) => Promise<GamepadPlayerStatus | null>;
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
      return (await unwrap<{ info: GamepadJoinInfo | null }>(res)).info;
    },
    joinSession: async (request) => {
      const res = await postJson("/join", request);
      const { sessionId, playerId, playerToken } =
        await unwrap<GamepadJoinResult>(res);
      return { sessionId, playerId, playerToken };
    },
    fetchPlayerStatus: async (token) => {
      const res = await postJson("/player/status", { token });
      return (await unwrap<{ status: GamepadPlayerStatus | null }>(res)).status;
    },
  };
};

/** The client for the API base the host configured. */
export const usePlayerApi = (): PlayerApi => {
  const { apiBase } = useKapulaConfig();
  return useMemo(() => createPlayerApi(apiBase), [apiBase]);
};
