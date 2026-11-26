"use client";

import { FarmWater } from "@/components/farm-water";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

export default function FarmWaterPage() {
  return (
    <Page>
      <FarmWorkspace title="Water">{(context) => <FarmWater organisationId={context.organisationId} farm={context.farm} />}</FarmWorkspace>
    </Page>
  );
}
