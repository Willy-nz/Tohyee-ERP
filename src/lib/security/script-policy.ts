import { createHash, randomBytes } from "node:crypto";
import { THEME_SCRIPT } from "@/components/theme-script";

/*
 * A script policy for pages (review finding L5), sent report-only for now.
 *
 * Only scripts Tohyee serves itself, with this response's nonce, or loaded
 * by those, may run: 'strict-dynamic' lets Next's own scripts load the
 * page's code. Next adds the nonce to its scripts on pages rendered for the
 * request, reading it from the policy on the request. The one inline script
 * of ours (the theme script in the root layout) is allowed by its hash, so
 * the layout doesn't need the nonce.
 *
 * Report-only: browsers report what this would block (in their developer
 * console) but block nothing. Some pages are rendered ahead of time, with no
 * request and so no nonce, and those would stop working if it were enforced.
 * It can be enforced once every page is checked.
 */

const hash = (script: string) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

export const THEME_SCRIPT_HASH = hash(THEME_SCRIPT);

export const SCRIPT_POLICY_HEADER = "Content-Security-Policy-Report-Only";

/** A fresh nonce for one response. */
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/** The policy for one response. In development React needs eval for its error overlay. */
export function scriptPolicy(nonce: string, development = process.env.NODE_ENV === "development"): string {
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${THEME_SCRIPT_HASH}${development ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
