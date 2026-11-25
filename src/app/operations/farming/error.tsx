"use client";

import { RouteError } from "@/components/route-error";

/** Shown inside the Farm tabs, so they stay when a farm page hits a problem. */
export default function FarmingError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/operations/farm", label: "Go to Today" }} />;
}
