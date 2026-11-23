"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { SavedSearches } from "@/components/saved-searches";
import { Page, PageHeader } from "@/components/ui";

export default function SavedSearchesPage() {
  return (
    <Page>
      <PageHeader title="Saved searches" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <SavedSearches key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
