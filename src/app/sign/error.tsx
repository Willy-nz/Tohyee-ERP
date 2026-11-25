"use client";

import { RouteError } from "@/components/route-error";

/** Customers sign here: a problem shows plain words, nothing about how Tohyee works inside. */
export default function SignError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} help="Try again. If it keeps happening, ask the business that sent you the link to send it again." />;
}
