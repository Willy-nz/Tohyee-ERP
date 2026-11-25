"use client";

import { useEffect } from "react";
import { errorReference } from "@/components/route-error";

/*
 * Shown when even the outer frame of the app fails to draw. It replaces the
 * whole page, so it brings its own <html> and <body> and plain inline
 * styles (the app's styles and theme don't reach it). The error's details
 * stay in the browser's console, never on screen.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const reference = errorReference(error);
  return (
    <html lang="en-NZ">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", lineHeight: 1.5, colorScheme: "light dark" }}>
        <title>Tohyee hit a problem</title>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "32px 16px" }}>
          <h1 style={{ fontSize: "1.4rem" }}>Tohyee hit a problem</h1>
          <p>Something went wrong showing this page. Anything you had already saved is still saved.</p>
          <p>Try again. If it keeps happening, tell whoever looks after Tohyee for you.</p>
          {reference ? <p>Reference: {reference}</p> : null}
          <p style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={() => retry()} style={{ font: "inherit", fontWeight: 600, padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "1px solid currentColor", cursor: "pointer" }}>
              Try again
            </button>
            {/* A full page load, not the app's own navigation, in case the app itself is what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see above */}
            <a href="/">Go to the start</a>
          </p>
        </main>
      </body>
    </html>
  );
}
