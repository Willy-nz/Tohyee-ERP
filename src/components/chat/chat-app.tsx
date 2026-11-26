"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { ChatFeed } from "@/components/chat/chat-feed";
import { ChatList, chatHref } from "@/components/chat/chat-list";
import { NewChat } from "@/components/chat/new-chat";
import { RoomPane } from "@/components/chat/room-pane";
import { FarmChat } from "@/components/farm-chat";
import { useApiData } from "@/components/hooks";
import { Notice, RefreshProblem } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { ChatListing } from "@/lib/chat/overview";
import { parseChatRef } from "@/lib/chat/rules";
import styles from "./chat.module.css";

/** How often the list checks for new messages while Chat is open. */
const LIST_POLL_MS = 15_000;

/**
 * The Chat app (TCH10): the list of chats down the side and the open one
 * beside it. On a phone the list is the first screen; tapping a chat opens
 * it on its own, and Back returns to the list. Which chat is open is in the
 * address (?chat=), so the phone's own Back works too.
 */
export function ChatApp({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const { current, user } = useWorkspace();
  const role = current?.role;
  const open = params.get("chat");
  const list = useApiData<ChatListing>("/api/chat/rooms", { organisationId });
  const reload = list.reload;

  useEffect(() => {
    const timer = window.setInterval(() => reload(), LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const canStart = role !== "viewer";
  const canRemoveAny = role === "owner" || role === "admin";
  const go = (value: string | null) => router.push(chatHref(value));
  const ref = parseChatRef(open);
  const farm = ref?.kind === "farm" ? list.data?.spaces.chats.find((chat) => chat.ref === open) : undefined;

  let pane = null;
  if (open === "new-direct" || open === "new-space") {
    pane = <NewChat key={open} organisationId={organisationId} kind={open === "new-direct" ? "direct" : "space"} onMade={(roomId) => { reload(); router.replace(chatHref(roomId)); }} onCancel={() => router.back()} />;
  } else if (open === "mentions") {
    pane = <ChatFeed key="mentions" organisationId={organisationId} kind="mentions" />;
  } else if (ref?.kind === "room") {
    pane = <RoomPane key={ref.id} organisationId={organisationId} roomId={ref.id} me={user.id} canRemoveAny={canRemoveAny} onLeft={() => { reload(); go(null); }} onChanged={reload} />;
  } else if (ref?.kind === "farm") {
    pane = farm ? (
      <div className={styles.main}>
        <h2>{farm.name}</h2>
        <FarmChat key={farm.ref} organisationId={organisationId} farm={{ id: ref.farmId, name: farm.name }} canRemoveAny={canRemoveAny} canPost={role !== "viewer"} inChatApp />
      </div>
    ) : list.data ? (
      <Notice tone="info">Chat not found.</Notice>
    ) : null;
  } else {
    pane = <ChatFeed key="home" organisationId={organisationId} kind="home" />;
  }

  return (
    <div className={styles.app} data-open={open ? "chat" : "list"}>
      <nav className={styles.side} aria-label="Chats">
        {list.error && !list.data ? <Notice tone="error">{list.error}</Notice> : null}
        <RefreshProblem problem={list.refreshError} loadedAt={list.loadedAt} onRetry={reload} />
        {list.data ? <ChatList list={list.data} open={open} canStart={canStart} onNew={(kind) => go(kind === "direct" ? "new-direct" : "new-space")} /> : null}
      </nav>
      <section className={styles.main} aria-label="Open chat">
        <button type="button" className={styles.back} onClick={() => go(null)}>
          ← Chats
        </button>
        {pane}
      </section>
    </div>
  );
}
