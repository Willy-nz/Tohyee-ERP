"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/**
 * Data sources and Prepare data are for whoever keeps the books. Someone who
 * only looks at reports is pointed back to them; the APIs refuse them too.
 */
export function AnalyticsSetUpOnly({ children }: { children: ReactNode }) {
  const { can } = useWorkspace();
  if (can("bookkeeper")) return <>{children}</>;
  return (
    <Notice tone="info">
      This page is for the people who keep the books. Your reports are under <Link href="/analytics">Reports</Link>.
    </Notice>
  );
}
