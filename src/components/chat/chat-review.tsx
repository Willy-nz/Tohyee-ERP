"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { ChatBubble, type Named } from "@/components/farm-chat";
import { useApiData } from "@/components/hooks";
import { Button, Notice, RefreshProblem } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { ReviewedRoom, ReviewEntry } from "@/lib/chat/review";
import styles from "./chat.module.css";

const REVIEW_NOTE = "Each chat you open here, and each photo or voice note, is recorded in the audit trail with your name and the time.";

function reviewHref(roomId: string | null): string {
  return roomId ? `/chat/review?chat=${encodeURIComponent(roomId)}` : "/chat/review";
}

/**
 * Review chats (TCH20, TCH21): for owners and admins, every space and direct
 * message, apart from their own list. No unread counts and no posting; each
 * chat opened is recorded. A space can be joined from here.
 */
export function ChatReview({ organisationId }: { organisationId: string }) {
  const params = useSearchParams();
  const open = params.get("chat");
  return (
    <div className={styles.main}>
      <Notice tone="warning">{REVIEW_NOTE}</Notice>
      {open ? <ReviewedChat key={open} organisationId={organisationId} roomId={open} /> : <ReviewIndex organisationId={organisationId} />}
    </div>
  );
}

function ReviewIndex({ organisationId }: { organisationId: string }) {
  const chats = useApiData<{ chats: ReviewEntry[] }>("/api/chat/review", { organisationId });
  if (chats.error && !chats.data) return <Notice tone="error">{chats.error}</Notice>;
  return (
    <>
      <RefreshProblem problem={chats.refreshError} loadedAt={chats.loadedAt} onRetry={chats.reload} />
      {chats.data && chats.data.chats.length === 0 ? <p className={styles.tag}>There are no spaces or direct messages yet.</p> : null}
      <ul className={styles.reviewList}>
        {(chats.data?.chats ?? []).map((chat) => (
          <li key={chat.id}>
            <Link href={reviewHref(chat.id)} className={styles.feedRow}>
              <span className={styles.feedMeta}>
                <strong>{chat.name}</strong>
                <span>{chat.kind === "direct" ? "Direct message" : "Space"}</span>
                <span>{chat.people} people</span>
                <span>{chat.messages} messages</span>
                {chat.closed ? <span>Closed</span> : null}
                {chat.youreIn ? <span>You&apos;re in it</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function ReviewedChat({ organisationId, roomId }: { organisationId: string; roomId: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  // Read once on opening: each opening is recorded, so this doesn't check for new messages by itself.
  const chat = useApiData<{ room: ReviewedRoom; messages: Named[]; more: boolean }>(`/api/chat/review/${encodeURIComponent(roomId)}`, { organisationId });
  const [older, setOlder] = useState<Named[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const room = chat.data?.room;
  const messages = [...older, ...(chat.data?.messages ?? [])];

  async function loadOlder() {
    const first = messages[0]?.id;
    if (!first) return;
    setError(null);
    try {
      const answer = await api<{ messages: Named[]; more: boolean }>(`/api/chat/review/${encodeURIComponent(roomId)}?${new URLSearchParams({ organisationId, before: first }).toString()}`);
      setOlder((current) => [...answer.messages, ...current]);
      setMore(answer.more);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function join() {
    setError(null);
    try {
      await api(`/api/chat/review/${encodeURIComponent(roomId)}/join`, { method: "POST", body: { organisationId } });
      router.push(`/chat?chat=${encodeURIComponent(roomId)}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove(message: Named) {
    if (!(await confirm("Take this message down? Its words, photos and voice note go for everyone; a note that it was taken down stays."))) return;
    setError(null);
    try {
      await api(`/api/chat/review/messages/${message.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      setOlder((current) => current.filter((entry) => entry.id !== message.id));
      chat.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <Link href={reviewHref(null)}>← All chats</Link>
      {chat.error && !room ? <Notice tone="error">{chat.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {room ? (
        <>
          <div className={styles.roomHead}>
            <h2>{room.name}</h2>
            {room.canJoin ? (
              <Button variant="secondary" onClick={() => void join()}>
                Join this space
              </Button>
            ) : null}
          </div>
          <p className={styles.tag}>
            {room.kind === "direct" ? "Direct message" : "Space"} · {room.members.map((member) => member.name).join(", ")}
            {room.closed ? " · Closed" : ""}
          </p>
          {(more ?? chat.data?.more) ? (
            <button type="button" className={styles.more} onClick={() => void loadOlder()}>
              Show older messages
            </button>
          ) : null}
          {messages.length === 0 ? <p className={styles.tag}>No messages.</p> : null}
          <ol className={styles.reviewMessages}>
            {messages.map((message) => (
              <ChatBubble key={message.id} api="/api/chat/review" message={message} organisationId={organisationId} onRemove={message.removed ? undefined : remove} />
            ))}
          </ol>
        </>
      ) : null}
    </>
  );
}
