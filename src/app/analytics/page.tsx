"use client";

import { Suspense } from "react";
import { DashboardsList } from "@/components/analytics/report-list";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function AnalyticsDashboardsPage() {
  return (
    <Page>
      <PageHeader title="Reports" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <DashboardsList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
