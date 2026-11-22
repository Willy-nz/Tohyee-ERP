"use client";

import { Suspense } from "react";
import { DataSourcesPage } from "@/components/analytics-sources";
import { AnalyticsSetUpOnly } from "@/components/analytics-setup-gate";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function AnalyticsPage() {
  return (
    <Page>
      <PageHeader title="Data sources" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <AnalyticsSetUpOnly><DataSourcesPage key={organisationId} organisationId={organisationId} /></AnalyticsSetUpOnly>}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
