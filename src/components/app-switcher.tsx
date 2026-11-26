"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useApiData } from "@/components/hooks";
import { IllustratedIcon } from "@/components/illustrated-icon";
import type { Modules } from "@/components/modules";
import styles from "./app-shell.module.css";

/** Tohyee's apps, each with its own top bar: Accounting (with Tax), Payroll (only while Accounting is off), Farm, the CRM, Analytics and Chat. */
export type AppKey = "accounting" | "payroll" | "farm" | "crm" | "analytics" | "chat";

const APPS: Array<{ key: AppKey; label: string; href: string }> = [
  { key: "accounting", label: "Accounting", href: "/operations" },
  { key: "payroll", label: "Payroll", href: "/operations/payroll/pay-runs" },
  { key: "farm", label: "Farm", href: "/operations/farm" },
  { key: "crm", label: "CRM", href: "/crm" },
  { key: "analytics", label: "Analytics", href: "/analytics" },
  { key: "chat", label: "Chat", href: "/chat" },
];

/**
 * The apps someone can switch to: the CRM only while it's on for the
 * organisation (MOD1), Accounting unless it's off (MOD2), Farm while
 * Farming is on (it needs Accounting). Farm staff have Farm only
 *.
 */
export function availableApps(modules: Modules | null, reportViewer = false, farmWorker = false): AppKey[] {
  // Report viewers only have Analytics.
  if (reportViewer) return ["analytics"];
  if (farmWorker) return modules?.farming ? ["farm"] : [];
  return APPS.filter(
    (app) =>
      (app.key !== "accounting" || modules?.accounting !== false) &&
      // Payroll is in Accounting's menus while Accounting is on, its own app while it's off (PAO2).
      (app.key !== "payroll" || (modules?.accounting === false && modules.payroll === true)) &&
      (app.key !== "farm" || (modules?.farming === true && modules.accounting !== false)) &&
      (app.key !== "crm" || modules?.crm === true) &&
      (app.key !== "analytics" || modules?.analytics === true) &&
      // Chat while it's on (TCH1); viewers and sales roles too.
      (app.key !== "chat" || modules?.chat === true),
  ).map((app) => app.key);
}

/** Messages this person hasn't read across all their chats (TCH5, TCH24), checked every minute while Chat is on. */
export function useTeamChatUnread(organisationId: string | null, on: boolean): number {
  const unread = useApiData<{ enabled: boolean; unread: number }>(on && organisationId ? "/api/chat/unread" : null, { organisationId: organisationId ?? "" });
  const reload = unread.reload;
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [on, reload]);
  return unread.data?.unread ?? 0;
}

/**
 * Moves between the apps. Shown only when
 * there's somewhere to switch to, so people without the CRM never see it
 * (nor while the organisation's modules are still loading).
 */
export function AppSwitcher({
  current,
  modules,
  reportViewer = false,
  farmWorker = false,
  chatUnread = 0,
}: {
  current: AppKey;
  modules: Modules | null;
  reportViewer?: boolean;
  farmWorker?: boolean;
  /** Unread team chat messages (TCH5), shown while you're in another app. */
  chatUnread?: number;
}) {
  const keys = availableApps(modules, reportViewer, farmWorker);
  const unread = current === "chat" ? 0 : chatUnread;
  if (keys.length < 2) return null;
  const apps = APPS.filter((app) => keys.includes(app.key));
  return (
    <details className={styles.appLauncher} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.currentTarget.removeAttribute("open");
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
      <summary className={styles.appLauncherButton} aria-label={unread > 0 ? `Apps, ${unread} unread in Chat` : "Apps"}>
        {unread > 0 ? <span className={styles.appLauncherDot} aria-hidden /> : null}
        <span className={styles.appLauncherGrid} aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </span>
      </summary>
      <nav aria-label="Apps" className={styles.appLauncherPanel}>
        {apps.map((app) => (
          <Link
            key={app.key}
            href={app.href}
            onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
            className={`${styles.appLauncherLink} ${app.key === current ? styles.appLauncherLinkActive : ""}`}
            aria-current={app.key === current ? "page" : undefined}
          >
            <IllustratedIcon name={app.key} />
            <span>{app.label}</span>
            {app.key === "chat" && unread > 0 ? <span className={styles.appLauncherBadge}>{unread} unread</span> : null}
          </Link>
        ))}
      </nav>
    </details>
  );
}
