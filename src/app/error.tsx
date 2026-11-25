"use client";

import { RouteError } from "@/components/route-error";

/** Any page that hits a problem while drawing shows this instead of a blank page. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/", label: "Go to the start" }} />;
}
