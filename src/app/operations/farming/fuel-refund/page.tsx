"use client";

import { RequireOrganisation } from "@/components/books";
import { FuelRefundView } from "@/components/fuel-refund";
import { Page, PageHeader } from "@/components/ui";

/** The fuel excise refund on off-road petrol (FUEL1-FUEL12). */
export default function FuelRefundPage() {
  return (
    <Page>
      <PageHeader title="Fuel excise refund" />
      <RequireOrganisation>{(organisationId) => <FuelRefundView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
