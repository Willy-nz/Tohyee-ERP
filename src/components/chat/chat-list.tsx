"use client";

import Link from "next/link";
import type { ChatListEntry, ChatListing } from "@/lib/chat/overview";
import styles from "./chat.module.css";

export function chatHref(open: string | null): string {
  return open ? `/chat?chat=${encodeURIComponent(open)}` : "/chat";
}

function Count({ unread }: { unread: number }) {
  if (unread <= 0) return null;
  return (
    <span className={styles.count} aria-label={`${unread} unread`}>
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

function Row({ href, label, unread, current, tag }: { href: string; label: string; unread: number; current: boolean; tag?: string }) {
  return (
    <Link href={href} className={`${styles.row} ${unread > 0 ? styles.unreadRow : ""}`} aria-current={current ? "page" : undefined}>
      <span className={styles.rowName}>{label}</span>
      {tag ? <span className={styles.tag}>{tag}</span> : null}
      <Count unread={unread} />
    </Link>
  );
}

function Section({ title, unread, chats, open, onNew }: { title: string; unread: number; chats: ChatListEntry[]; open: string | null; onNew?: () => void }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionHead}>
        <span>
          {title} <Count unread={unread} />
        </span>
        {onNew ? (
          <button type="button" onClick={onNew} aria-label={title === "Spaces" ? "New space" : "New direct message"}>
            New
          </button>
        ) : null}
      </h2>
      {chats.length === 0 ? <p className={styles.tag}>None yet.</p> : null}
      {chats.map((chat) => (
        <Row
          key={chat.ref}
          href={chatHref(chat.ref)}
          label={chat.name}
          unread={chat.unread}
          current={open === chat.ref}
          tag={chat.closed ? "Closed" : chat.kind === "farm" ? "Farm" : undefined}
        />
      ))}
    </section>
  );
}

/** The list down the side (TCH10): Home, Mentions, Direct messages, then Spaces, each with unread counts. */
export function ChatList({ list, open, canStart, onNew }: { list: ChatListing; open: string | null; canStart: boolean; onNew: (kind: "direct" | "space") => void }) {
  return (
    <>
      <section className={styles.section} aria-label="Home and mentions">
        <Row href={chatHref("home")} label="Home" unread={list.home.unread} current={open === "home" || open === null} />
        <Row href={chatHref("mentions")} label="Mentions" unread={list.mentions.unread} current={open === "mentions"} />
      </section>
      <Section title="Direct messages" unread={list.direct.unread} chats={list.direct.chats} open={open} onNew={canStart ? () => onNew("direct") : undefined} />
      <Section title="Spaces" unread={list.spaces.unread} chats={list.spaces.chats} open={open} onNew={canStart ? () => onNew("space") : undefined} />
    </>
  );
}
