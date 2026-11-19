"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** The longest voice note (FCH9). */
export const MAX_VOICE_SECONDS = 180;

/** Formats a voice note's length as m:ss. */
export function voiceLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The recording format to ask for. MP4 first because every phone can play it;
 * then WebM and Ogg for browsers that can't record MP4.
 */
export function pickVoiceFormat(supported: (type: string) => boolean): string | undefined {
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => supported(type));
}

export type VoiceNote = { file: File; seconds: number; url: string };

/**
 * Records one voice note from the microphone, up to 3 minutes (FCH9). Stops by
 * itself at 3 minutes. Nothing leaves the phone until the message is sent.
 */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);

  const stop = useCallback(() => {
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setProblem(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setProblem("This browser can't record here. Recording needs Tohyee opened over https.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setProblem("Tohyee couldn't use the microphone. Allow the microphone for this site, then try again.");
      return;
    }
    const mimeType = pickVoiceFormat((type) => MediaRecorder.isTypeSupported(type));
    const made = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    made.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    made.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      recorder.current = null;
      setRecording(false);
      const seconds = Math.min(MAX_VOICE_SECONDS, Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
      const type = made.mimeType || chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        setProblem("Nothing was recorded. Try again.");
        return;
      }
      const file = new File([blob], "voice-note", { type });
      setNote((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { file, seconds, url: URL.createObjectURL(blob) };
      });
    };
    recorder.current = made;
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
    made.start();
    timer.current = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_VOICE_SECONDS) stop();
    }, 250);
  }, [stop]);

  const clear = useCallback(() => {
    setNote((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  // Leaving the screen stops the microphone.
  useEffect(
    () => () => {
      if (recorder.current && recorder.current.state !== "inactive") {
        recorder.current.onstop = null;
        recorder.current.stream.getTracks().forEach((track) => track.stop());
        recorder.current.stop();
      }
      if (timer.current !== null) window.clearInterval(timer.current);
    },
    [],
  );

  return { recording, elapsed, note, problem, start, stop, clear };
}
