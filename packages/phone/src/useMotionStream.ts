import { useEffect } from "react";
import type { GamepadMotionControl, GamepadPlayerClientMessage } from "@kapula/protocol";
import { GAMEPAD_MOTION_BATCH_MAX } from "@kapula/protocol";
import {
  MOTION_BATCH_SIZE,
  MOTION_FLUSH_MS,
  MOTION_SIGN_TIMEOUT_MS,
  createAccelSignEstimator,
  encodeMotionSample,
  expectedReaction,
  readMotionEvent,
  type RawMotion,
} from "./motion-utils.js";
import { useGyroAccess, type GyroAccess } from "./useGyro.js";

/**
 * Streams the raw IMU for a schema's `motion` control: every devicemotion
 * event becomes a wire sample, a few samples make one `motion` message.
 * Nothing is throttled or coalesced — unlike the input sender this is a
 * stream where every sample matters (an emulator integrates the rates and
 * looks for shakes in the accelerations).
 *
 * The first samples wait, briefly, for the accelerometer sign to be decided
 * against the orientation sensor (see motion-utils.ts), so a driver never
 * sees the sign flip mid-stream. Motion access is the same permission and
 * probe as tilt: `useGyro.ts` owns that state machine.
 */
export const useMotionStream = ({
  control,
  enabled,
  send,
}: {
  control: GamepadMotionControl | undefined;
  enabled: boolean;
  send: (msg: GamepadPlayerClientMessage) => void;
}): { access: GyroAccess } => {
  const access = useGyroAccess();

  useEffect(() => {
    if (!control || !enabled || access !== "granted") return;

    const estimator = createAccelSignEstimator();
    let sign: 1 | -1 | null = null;
    let expectedUp: [number, number, number] | null = null;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      expectedUp = expectedReaction({ beta: e.beta, gamma: e.gamma });
    };

    let pending: RawMotion[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      const settled = sign;
      if (settled === null || pending.length === 0) return;
      // Samples held while the sign settled may exceed one message.
      const batch = pending;
      pending = [];
      for (let i = 0; i < batch.length; i += GAMEPAD_MOTION_BATCH_MAX) {
        send({
          type: "motion",
          samples: batch
            .slice(i, i + GAMEPAD_MOTION_BATCH_MAX)
            .map((raw) => encodeMotionSample(raw, settled)),
        });
      }
    };

    const signDeadline = window.setTimeout(() => {
      // No agreeing static samples in time (a phone already being swung, or
      // no orientation events at all): assume the spec sign and start.
      sign ??= 1;
      flush();
    }, MOTION_SIGN_TIMEOUT_MS);

    const onMotion = (e: DeviceMotionEvent) => {
      const raw = readMotionEvent(e);
      if (!raw) return;
      if (sign === null) {
        if (expectedUp) estimator.observe(raw.accel, expectedUp);
        sign = estimator.sign;
        // Cap what the settling phase can hold back.
        if (pending.length >= GAMEPAD_MOTION_BATCH_MAX * 2) pending.shift();
      }
      pending.push(raw);
      if (sign === null) return;
      if (pending.length >= MOTION_BATCH_SIZE) flush();
      else flushTimer ??= window.setTimeout(flush, MOTION_FLUSH_MS);
    };

    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
    return () => {
      window.clearTimeout(signDeadline);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("devicemotion", onMotion);
    };
  }, [control, enabled, access, send]);

  return { access };
};
