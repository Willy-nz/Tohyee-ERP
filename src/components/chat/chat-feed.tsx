"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { chatHref } from "@/components/chat/chat-list";
import { useApiData } from "@/components/hooks";
import { Notice, RefreshProblem } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { FeedMessage } from "@/lib/chat/overview";
import styles from "./chat.module.css";

type Shown = FeedMessage & { postedByName?: string };

function when(at: string): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function snippet(message: Shown): string {
  if (message.body) return message.body;
  const photos = message.attachments.filter((file) => file.kind === "photo").length;
  if (message.attachments.some((file) => file.kind === "voice")) return "Voice note";
  return photos === 1 ? "Photo" : `${photos} photos`;
}

/**
 * Home (TCH10): the latest messages from every chat you're in, newest first,
 * each naming its chat. Mentions (TCH18): messages that mention you.
 * Tapping a row opens its chat.
 */
export function ChatFeed({ organisationId, kind, onSeen }: { organisationId: string; kind: "home" | "mentions"; onSeen?: () => void }) {
  const path = kind === "home" ? "/api/chat/home" : "/api/chat/mentions";
  const feed = useApiData<{ messages: Shown[]; more: boolean }>(path, { organisationId });
  const [older, setOlder] = useState<Shown[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = feed.reload;

  useEffect(() => {
    const timer = window.setInterval(() => reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    if (feed.data) onSeen?.();
  }, [feed.data, onSeen]);

  const messages = [...(feed.data?.messages ?? []), ...older];
  async function loadOlder() {
    const last = messages.at(-1)?.id;
    if (!last) return;
    setError(null);
    try {
      const answer = await api<{ messages: Shown[]; more: boolean }>(`${path}?${new URLSearchParams({ organisationId, before: last }).toString()}`);
      setOlder((current) => [...current, ...answer.messages]);
      setMore(answer.more);
    } catch (caught) {
      setError(`Couldn't load older messages. ${errorMessage(caught)}`);
    }
  }

  return (
    <div className={styles.main}>
      <h2>{kind === "home" ? "Home" : "Mentions"}</h2>
      {feed.error && !feed.data ? <Notice tone="error">{feed.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <RefreshProblem problem={feed.refreshError} loadedAt={feed.loadedAt} onRetry={reload} />
      {feed.data && messages.length === 0 ? <p className={styles.tag}>{kind === "home" ? "No messages yet." : "No one has mentioned you yet."}</p> : null}
      <ol className={styles.feed}>
        {messages.map((message) => (
          <li key={message.id}>
            <Link href={chatHref(message.chat.ref)} className={`${styles.feedRow} ${message.unread ? styles.unreadFeed : ""}`}>
              <span className={styles.feedMeta}>
                <strong>{message.chat.name}</strong>
                <span>{message.postedByName ?? message.postedByEmail}</span>
                {message.viaAi ? <span>via their AI</span> : null}
                <span>{when(message.createdAt)}</span>
                {message.unread ? <span>Unread</span> : null}
              </span>
              <span className={styles.feedBody}>{snippet(message)}</span>
            </Link>
          </li>
        ))}
      </ol>
      {(more ?? feed.data?.more) ? (
        <button type="button" className={styles.more} onClick={() => void loadOlder()}>
          Show older messages
        </button>
      ) : null}
    </div>
  );
}
