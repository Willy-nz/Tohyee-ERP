"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { ChatReview } from "@/components/chat/chat-review";
import { useModules } from "@/components/modules";
import { Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/** Review chats (TCH20, TCH21): owners and admins only. */
export default function ChatReviewPage() {
  return (
    <Page>
      <PageHeader title="Review chats" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <ReviewForOrganisation key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}

function ReviewForOrganisation({ organisationId }: { organisationId: string }) {
  const { current } = useWorkspace();
  const modules = useModules(organisationId);
  if (current?.role !== "owner" && current?.role !== "admin") return <Notice tone="info">Review chats is for owners and admins.</Notice>;
  if (!modules) return null;
  if (!modules.chat) return <Notice tone="info">Chat is off. An admin can turn it on under Settings, Modules.</Notice>;
  return <ChatReview organisationId={organisationId} />;
}
