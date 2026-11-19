"use client";

import { useSearchParams } from "next/navigation";
import { FarmChat } from "@/components/farm-chat";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function FarmChatPage() {
  const params = useSearchParams();
  const { current } = useWorkspace();
  const canRemoveAny = current?.role === "owner" || current?.role === "admin";
  return (
    <Page>
      <FarmWorkspace title="Chat" linkedFarmId={params.get("farm")}>
        {(context) => <FarmChat key={context.farm.id} organisationId={context.organisationId} farm={context.farm} canRemoveAny={canRemoveAny} />}
      </FarmWorkspace>
    </Page>
  );
}
