"use client";

import { RouteError } from "@/components/route-error";

/** Shown inside the menus, so they stay when an operations page hits a problem. */
export default function OperationsError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/operations", label: "Go to the dashboard" }} />;
}
