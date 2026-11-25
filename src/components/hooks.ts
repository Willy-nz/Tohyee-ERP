"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "@/lib/client/api";

type Query = Record<string, string | number | boolean | null | undefined>;

export type LoadState<T> = {
  data: T | null;
  /** Set only when there's nothing to show: the first load of this request failed. */
  error: string | null;
  /** A reload of the same request failed while `data` (the last good answer) is still shown. */
  refreshError: string | null;
  /** When `data` was loaded (milliseconds since 1970), so a screen can say how old it is. */
  loadedAt: number | null;
  key: string | null;
};

export const EMPTY_LOAD_STATE: LoadState<never> = { data: null, error: null, refreshError: null, loadedAt: null, key: null };

/**
 * The next state after a load for `key` finishes. A failed reload of the same
 * request keeps the last good data and reports the failure as `refreshError`,
 * so a dropped signal doesn't blank the screen (and polls that depend on the
 * data keep going). A failure for a new request, or before anything loaded,
 * is an `error` as before, so a screen never shows another request's data.
 */
export function nextLoadState<T>(
  previous: LoadState<T>,
  key: string,
  result: { ok: true; data: T; at: number } | { ok: false; message: string },
): LoadState<T> {
  if (result.ok) return { data: result.data, error: null, refreshError: null, loadedAt: result.at, key };
  if (previous.key === key && previous.data !== null) {
    return { ...previous, error: null, refreshError: result.message };
  }
  return { data: null, error: result.message, refreshError: null, loadedAt: null, key };
}

/** How long to wait before trying a failed refresh again on its own. */
export const REFRESH_RETRY_MS = 30_000;

/**
 * Loads JSON from the API whenever the path or query changes. Pass a null path
 * to skip loading (e.g. no organisation selected yet).
 *
 * `error` means nothing could be loaded. When a reload fails after a good load,
 * the last data stays in `data` and the problem is in `refreshError` (screens
 * can show <RefreshProblem>); the hook tries again by itself when the device
 * comes back online, and every 30 seconds while it keeps failing.
 */
export function useApiData<T>(path: string | null, query: Query = {}) {
  const queryKey = JSON.stringify(query);
  const requestKey = path ? `${path}?${queryKey}` : null;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<LoadState<T>>(EMPTY_LOAD_STATE);

  useEffect(() => {
    if (!path) {
      return;
    }
    let cancelled = false;
    const key = `${path}?${queryKey}`;
    api<T>(path, { query: JSON.parse(queryKey) as Query }).then(
      (data) => {
        if (!cancelled) setState((previous) => nextLoadState(previous, key, { ok: true, data, at: Date.now() }));
      },
      (error) => {
        if (!cancelled) setState((previous) => nextLoadState(previous, key, { ok: false, message: errorMessage(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, queryKey, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const current = state.key === requestKey;
  const failing = current && state.refreshError !== null;

  // While a refresh keeps failing, try again when the signal comes back and now and then.
  useEffect(() => {
    if (!failing) return;
    const timer = window.setTimeout(reload, REFRESH_RETRY_MS);
    window.addEventListener("online", reload);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", reload);
    };
  }, [failing, reload, version]);

  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    refreshError: current ? state.refreshError : null,
    loadedAt: current ? state.loadedAt : null,
    loading: requestKey !== null && !current,
    reload,
  };
}

const noopSubscribe = () => () => undefined;

/**
 * False while rendering on the server and during hydration, true afterwards.
 * Pages that depend on the browser (today's date, the chosen organisation)
 * render their content only once this is true, so server and browser HTML
 * never disagree.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
