"use client";

import Link from "next/link";
import { IllustratedIcon, type IllustratedIconName } from "@/components/illustrated-icon";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useApiData } from "@/components/hooks";
import { useWorkspace } from "@/components/workspace";
import { FARM_TABS, farmTabFor } from "@/lib/farming/farm-nav";
import styles from "./farm-frame.module.css";

/*
 * Every farm page's frame, from the shared
 * layouts of /operations/farm and /operations/farming: the Farm tabs
 * (Today · Map · Log · Chat · Safety · More) are drawn by the layout, not by each
 * page once its data has loaded, so they're there on a direct link, a
 * reload, a page opened offline and while a page is still loading. On a
 * phone they sit at the bottom, above the phone's own bar, and the page
 * leaves room for them so nothing is hidden behind them.
 */
const TAB_ART: Partial<Record<string, IllustratedIconName>> = { today: "calendar", map: "maps", safety: "safety" };

/** Unread farm chat messages across the person's farms (FCH6), checked every minute. */
function useChatUnread(): number {
  const { current } = useWorkspace();
  const unread = useApiData<{ farms: Array<{ farmId: string; unread: number }> }>(current ? "/api/farming/chat/unread" : null, { organisationId: current?.id ?? "" });
  const reload = unread.reload;
  useEffect(() => {
    const timer = window.setInterval(() => reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return (unread.data?.farms ?? []).reduce((sum, farm) => sum + farm.unread, 0);
}

export function FarmFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = farmTabFor(pathname);
  const unread = useChatUnread();
  return (
    <div className={styles.frame}>
      <nav className={styles.tabs} aria-label="Farm">
        {FARM_TABS.map((entry) => (
          <Link key={entry.key} href={entry.href} className={styles.tab} aria-current={entry.key === current ? "page" : undefined} data-farm-tab={entry.key}>
            <span className={styles.tabIcon} aria-hidden="true">
              {TAB_ART[entry.key] ? <IllustratedIcon name={TAB_ART[entry.key]!} size={28} /> : entry.icon}
            </span>
            {entry.label}
            {entry.key === "chat" && unread > 0 && current !== "chat" ? (
              <span className={styles.badge} aria-label={`${unread} unread`}>
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
