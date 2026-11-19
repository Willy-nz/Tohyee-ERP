"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ChatAbout } from "@/components/farm-chat";
import { FarmTimeline } from "@/components/farm-timeline";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** The farm's timeline. `?farm=`, `?mob=` and `?paddock=` open it filtered. */
function Timeline() {
  const params = useSearchParams();
  return (
    <FarmWorkspace title="Farm timeline" linkedFarmId={params.get("farm")}>
      {(context) => (
        <>
          {params.get("paddock") ? <ChatAbout organisationId={context.organisationId} kind="paddock" recordId={params.get("paddock")!} /> : null}
          {params.get("mob") ? <ChatAbout organisationId={context.organisationId} kind="mob" recordId={params.get("mob")!} /> : null}
          <FarmTimeline {...context} mobId={params.get("mob")} paddockId={params.get("paddock")} />
        </>
      )}
    </FarmWorkspace>
  );
}

export default function FarmTimelinePage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <Timeline />
      </Suspense>
    </Page>
  );
}
