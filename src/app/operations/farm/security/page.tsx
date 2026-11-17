"use client";

import { FarmSecurity } from "@/components/farm-security";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** Security cameras: under More, for people given camera access. */
export default function FarmSecurityPage() {
  return (
    <Page>
      <FarmWorkspace title="Security">{(context) => <FarmSecurity organisationId={context.organisationId} farm={context.farm} farms={context.farms} />}</FarmWorkspace>
    </Page>
  );
}
