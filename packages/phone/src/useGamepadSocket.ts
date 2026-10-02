import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GamepadDriverClientMessage,
  GamepadPlayerClientMessage,
  GamepadServerMessage,
} from "@kapula/protocol";

/** Server-initiated closes that reconnecting cannot fix. */
const FATAL_CLOSE_CODES = new Set([4001, 4004, 4005, 4008, 4010, 4011]);

/**
 * Application-level keepalive. The server runs its own WebSocket ping/pong
 * liveness probe, but those frames are invisible to the reverse proxies in
 * between, which drop a socket that has carried no data for a while — a
 * lobby that waits, or a paused game, otherwise flickers through a
 * disconnect/reconnect. 25 s keeps us under the usual 30–60 s idle timeouts,
 * and the server does not count pings as session activity, so this never
 * keeps a forgotten session alive.
 */
const PING_INTERVAL_MS = 25_000;

export type GamepadSocket = {
  isConnected: boolean;
  /** Set when the server closed us for good (ended, replaced, not found). */
  fatalClose: { code: number; reason: string } | null;
  send: (msg: GamepadPlayerClientMessage | GamepadDriverClientMessage) => void;
};

/**
 * Session WebSocket (`buildGamepadWsUrl` in config.tsx) with automatic
 * reconnection; modeled on the video app's useSignaling. Fatal close codes stop the reconnect loop and are
 * surfaced so the caller can clear stored credentials.
 */
export function useGamepadSocket(
  url: string | null,
  onMessage: (msg: GamepadServerMessage) => void,
): GamepadSocket {
  const [isConnected, setIsConnected] = useState(false);
  const [fatalClose, setFatalClose] = useState<GamepadSocket["fatalClose"]>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectTimerRef = useRef<number | null>(null);

  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!url) return;
    setFatalClose(null);

    let cancelled = false;
    let attempt = 0;
    let pingTimer: number | null = null;
    const stopPings = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setIsConnected(true);
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onclose = (ev) => {
        stopPings();
        if (cancelled) return;
        setIsConnected(false);
        wsRef.current = null;
        if (FATAL_CLOSE_CODES.has(ev.code)) {
          setFatalClose({ code: ev.code, reason: ev.reason });
          return;
        }
        attempt += 1;
        const delay = Math.min(3000, 500 + attempt * 400);
        reconnectTimerRef.current = window.setTimeout(() => {
          if (!cancelled) connect();
        }, delay);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as GamepadServerMessage;
          onMessageRef.current(msg);
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      stopPings();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.CONNECTING) {
          // Closing a still-connecting socket logs a browser console error
          // (hit on every mount under StrictMode); close it once it opens.
          ws.onopen = () => ws.close();
        } else {
          ws.onopen = null;
          ws.close();
        }
      }
      setIsConnected(false);
    };
  }, [url]);

  const send = useCallback(
    (msg: GamepadPlayerClientMessage | GamepadDriverClientMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
    [],
  );

  return { isConnected, fatalClose, send };
}
