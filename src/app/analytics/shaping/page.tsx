"use client";

import { Suspense } from "react";
import { AnalyticsShapingPage } from "@/components/analytics-shaping";
import { AnalyticsSetUpOnly } from "@/components/analytics-setup-gate";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function ShapingPage() {
  return (
    <Page>
      <PageHeader title="Prepare data" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <AnalyticsSetUpOnly><AnalyticsShapingPage key={organisationId} organisationId={organisationId} /></AnalyticsSetUpOnly>}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
