"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, Card, Notice, Page, ui } from "@/components/ui";

/** The reference Next.js gives a server error, to match it in the server's log; never the error's own words. */
export function errorReference(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("digest" in error)) return null;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && /^[\w-]{1,64}$/.test(digest) ? digest : null;
}

/**
 * What a page shows instead of going blank when it hits a problem while
 * drawing (the app's error.tsx files). Plain words, Try again, and a way
 * back; the error's details stay in the browser's console, not on screen.
 */
export function RouteError({
  error,
  retry,
  home,
  help = "Try again. If it keeps happening, go back and open the page again, or tell whoever looks after Tohyee for you.",
}: {
  error: unknown;
  retry: () => void;
  home?: { href: string; label: string };
  help?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const reference = errorReference(error);
  return (
    <Page>
      <Card title="This page hit a problem">
        <Notice tone="error">Something went wrong showing this page. Anything you had already saved is still saved.</Notice>
        <p>{help}</p>
        {reference ? <p>Reference: {reference}</p> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button onClick={() => retry()}>Try again</Button>
          {home ? (
            <Link href={home.href} className={`${ui.button} ${ui.secondary}`}>
              {home.label}
            </Link>
          ) : null}
        </div>
      </Card>
    </Page>
  );
}
