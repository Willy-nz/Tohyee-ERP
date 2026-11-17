"use client";

import Link from "next/link";
import { useApiData } from "@/components/hooks";
import { Card,Field,ui } from "@/components/ui";
import { formatDate,todayInBrowser } from "@/lib/format";
import type { LivestockSettings,MovementType } from "@/lib/livestock/movements";

/*
 * Accounting › Livestock (examples LV1-LV12): movements and head
 * counts, then the year-end valuation, then review and post. Shared types
 * only: the work is done on the server.
 */

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  birth: "Born",
  purchase: "Bought",
  sale: "Sold",
  death: "Died",
  missing: "Missing",
  found: "Found",
  reclass: "Class change",
  transfer: "Moved",
  arrival: "Arrived (someone else's)",
  departure: "Left (someone else's)",
  rations: "Killed for rations",
};

export const MOVEMENT_ORDER: MovementType[] = ["birth", "purchase", "sale", "death", "missing", "found", "reclass", "transfer", "arrival", "departure", "rations"];

/** Year ends from the first year to the one containing today. */
export function yearEnds(settings: LivestockSettings): string[] {
  if (!settings.firstYearStart) return [];
  const result: string[] = [];
  const month = settings.financialYearEndMonth;
  const endOf = (year: number) => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  };
  const firstEndYear = Number(settings.firstYearStart.slice(0, 4)) + (month === 12 ? 0 : 1);
  const today = todayInBrowser();
  for (let year = firstEndYear; year < firstEndYear + 50; year += 1) {
    const end = endOf(year);
    result.push(end);
    if (end >= today) break;
  }
  return result.reverse();
}

/** The latest year that has ended (the one usually being worked on), or the first year. */
export function defaultYear(years: string[]): string {
  const today = todayInBrowser();
  return years.find((year) => year < today) ?? years[years.length - 1];
}

export function useLivestockSettings(organisationId: string) {
  return useApiData<{ settings: LivestockSettings }>("/api/livestock/settings", { organisationId });
}

export function NotOn({ canSetUp }: { canSetUp: boolean }) {
  return (
    <Card title="Livestock isn't turned on">
      <p>
        Livestock records a farm&apos;s dairy cattle, beef cattle and sheep, reconciles head counts by class and values them at year end under the herd scheme or national
        standard cost.
      </p>
      {canSetUp ? (
        <Link className={`${ui.button} ${ui.primary}`} href="/operations/livestock/settings">
          Set up livestock
        </Link>
      ) : (
        <p className={ui.muted}>An admin can turn it on.</p>
      )}
    </Card>
  );
}

export function YearPicker({ years, value, onChange }: { years: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Year ending">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {years.map((year) => (
          <option key={year} value={year}>
            {formatDate(year)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Steps({ current }: { current: "movements" | "account-sales" | "valuation" | "overview" | "management" }) {
  const steps = [
    { key: "movements", href: "/operations/livestock/movements", label: "1. Movements", text: "Births, purchases, sales, deaths and moves" },
    { key: "account-sales", href: "/operations/livestock/account-sales", label: "Account sales", text: "Stock agents' account sales, entered once" },
    { key: "overview", href: "/operations/livestock", label: "2. Head count", text: "Reconcile by class; enter the year-end count" },
    { key: "valuation", href: "/operations/livestock/valuation", label: "3. Value, review and post", text: "Workings, trading statement and the journal" },
    { key: "management", href: "/operations/livestock/management", label: "Management values", text: "Monthly stock on hand at the farm's own values; posts nothing" },
  ];
  return (
    <nav className={ui.tabs} aria-label="Livestock steps">
      {steps.map((step) => (
        <Link key={step.key} href={step.href} className={`${ui.tab} ${current === step.key ? ui.tabActive : ""}`} title={step.text} aria-current={current === step.key ? "page" : undefined}>
          {step.label}
        </Link>
      ))}
    </nav>
  );
}

// Account sales ------------------------------------------------------------------------

export type ContactOption = { id: string; name: string };
