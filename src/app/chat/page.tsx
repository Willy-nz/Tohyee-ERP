"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { TeamChat } from "@/components/farm-chat";
import { useModules } from "@/components/modules";
import { Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/** The organisation's team chat (TCH1-TCH6). */
export default function ChatPage() {
  return (
    <Page>
      <PageHeader title="Chat" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <ChatForOrganisation key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}

function ChatForOrganisation({ organisationId }: { organisationId: string }) {
  const { current } = useWorkspace();
  const modules = useModules(organisationId);
  const role = current?.role;
  if (role === "farm_worker" || role === "report_viewer") return <Notice tone="info">Chat isn&apos;t open to your role in this organisation.</Notice>;
  if (!modules) return null;
  if (!modules.chat) return <Notice tone="info">Chat is off. An admin can turn it on under Settings, Modules.</Notice>;
  return (
    <TeamChat
      organisationId={organisationId}
      name={current?.displayName ?? "the team"}
      canRemoveAny={role === "owner" || role === "admin"}
      canPost={role !== "viewer"}
    />
  );
}
