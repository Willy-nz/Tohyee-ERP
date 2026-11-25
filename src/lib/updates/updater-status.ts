/**
 * What the Tohyee updater's status file means for Update now (UPD6-UPD9).
 * Pure functions, no Node imports, so the page and the server agree.
 *
 * The file is written by the updater (downloading, installing, skipped,
 * failed) and, from 0.46.0, by the installer itself (installed, or failed
 * with what was done about it). Older installers never wrote a final state,
 * so "installing" alone can't mean "still busy": the running version and the
 * time this server last started decide.
 */

export const UPDATER_STATES = ["downloading", "installing", "installed", "failed", "skipped"] as const;
export type UpdaterState = (typeof UPDATER_STATES)[number];

/**
 * - working: the updater is busy now (Update now waits).
 * - installed: this server runs the version the status is about.
 * - failed: it didn't install, said by the updater or the installer, or seen
 *   from this server starting again on the old version, or from it taking too long.
 * - skipped: the updater refused the request (already installed, or a newer release is out).
 * - old: about an earlier update, since overtaken (nothing to show).
 */
export type UpdaterOutcome = "working" | "installed" | "failed" | "skipped" | "old";

export type UpdaterStatus = {
  state: UpdaterState;
  version: string | null;
  message: string | null;
  at: string | null;
  /** Downloading or installing for too long without this server coming back on that version. */
  overdue: boolean;
  outcome: UpdaterOutcome;
  /** When the outcome was worked out here rather than written by the updater: why, and what to do. */
  note: string | null;
};

/** How long an install can take before the page says it didn't finish. */
export const INSTALL_OVERDUE_AFTER_MS = 20 * 60 * 1000;
/** The updater's scheduled task stops after 45 minutes, so a download can't take longer. */
export const DOWNLOAD_OVERDUE_AFTER_MS = 45 * 60 * 1000;

const VERSION = /^\d+\.\d+\.\d+$/;

/** Compares two x.y.z versions: negative, 0 or positive. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function time(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : Number.NaN;
}

/**
 * The updater's status file, cleaned up (only known states and short text),
 * with what it means now. `serverStartedAt` is when this server last started:
 * a download or install from before that start, for a version this server
 * doesn't run, didn't finish.
 */
export function parseUpdaterStatus(
  text: string,
  now: Date,
  currentVersion: string,
  serverStartedAt: string | null = null,
): UpdaterStatus | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const state = UPDATER_STATES.find((known) => known === parsed.state);
  if (!state) return null;
  const short = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const given = short(parsed.version, 20);
  const version = given && VERSION.test(given) ? given : null;
  const at = short(parsed.at, 40);
  const message = short(parsed.message, 500);
  const base = { state, version, message, at };

  const started = time(at);
  const behind = version !== null && compareVersions(version, currentVersion) > 0;
  const runningIt = version !== null && version === currentVersion;

  if (state === "installed") {
    return { ...base, overdue: false, outcome: runningIt ? "installed" : behind ? "failed" : "old", note: behind ? notRunning(version, currentVersion) : null };
  }
  if (state === "failed") return { ...base, overdue: false, outcome: version !== null && !behind ? "old" : "failed", note: null };
  if (state === "skipped") return { ...base, overdue: false, outcome: "skipped", note: null };

  // downloading or installing
  if (runningIt) return { ...base, overdue: false, outcome: "installed", note: null };
  if (version !== null && !behind) return { ...base, overdue: false, outcome: "old", note: null };
  const restartedSince = Number.isFinite(started) && Number.isFinite(time(serverStartedAt)) && time(serverStartedAt) > started;
  if (restartedSince) {
    return { ...base, overdue: false, outcome: "failed", note: notRunning(version, currentVersion) };
  }
  const limit = state === "downloading" ? DOWNLOAD_OVERDUE_AFTER_MS : INSTALL_OVERDUE_AFTER_MS;
  const overdue = Number.isFinite(started) && now.getTime() - started > limit;
  if (overdue) {
    return { ...base, overdue: true, outcome: "failed", note: `It's been more than ${Math.round(limit / 60_000)} minutes. ${notRunning(version, currentVersion)}` };
  }
  return { ...base, overdue: false, outcome: "working", note: null };
}

function notRunning(version: string | null, current: string): string {
  return (
    `This server still runs v${current}, so the update to v${version ?? "?"} didn't finish. ` +
    "Your data is safe: it was backed up first. Try Update now again. If it fails again, run the installer on the server computer and look at the installer's log in Tohyee's logs folder."
  );
}

/** Whether Update now can be pressed: not while the updater is busy. Anything else (done, failed, skipped, too long) lets it go again. */
export function updaterBusy(status: UpdaterStatus | null): boolean {
  return status?.outcome === "working";
}
