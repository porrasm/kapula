import { useEffect, useRef } from "react";
import type { KapulaPlayerClientMessage } from "@kapula/protocol";
import { deviceInfoFor } from "./device-utils.js";
import { useGyroAccess } from "./useGyro.js";

const RESIZE_DEBOUNCE_MS = 500;

/**
 * Reports the device class to the server: right after each (re)connect, when
 * the tilt probe result changes, and on viewport changes (debounced).
 */
export const useDeviceInfo = (
  isConnected: boolean,
  send: (msg: KapulaPlayerClientMessage) => void,
) => {
  const motion = useGyroAccess() === "granted";
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!isConnected) return;
    const touch =
      typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
    const report = () =>
      sendRef.current({
        type: "device_info",
        device: deviceInfoFor(window.innerWidth, window.innerHeight, touch, motion),
      });
    report();
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(report, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [isConnected, motion]);
};
