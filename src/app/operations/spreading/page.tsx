"use client";

import { RequireOrganisation } from "@/components/books";
import { Spreading } from "@/components/spreading";
import { Page, PageHeader } from "@/components/ui";

export default function SpreadingPage() {
  return (
    <Page>
      <PageHeader title="Spreading" />
      <RequireOrganisation>{(organisationId) => <Spreading key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
