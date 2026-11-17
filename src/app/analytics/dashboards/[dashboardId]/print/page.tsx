"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { PrintReport } from "@/components/analytics/print-report";
import { RequireOrganisation } from "@/components/books";
import { Page } from "@/components/ui";

function PrintPageInner() {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  return <RequireOrganisation>{(organisationId) => <PrintReport key={`${organisationId}-${dashboardId}`} organisationId={organisationId} dashboardId={dashboardId} />}</RequireOrganisation>;
}

/** A report as A4 sheets, to print or save as a PDF. */
export default function AnalyticsDashboardPrintPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <PrintPageInner />
      </Suspense>
    </Page>
  );
}
