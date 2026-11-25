import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { runMonthlyLateFees } from "@/lib/invoices/late-fees";
import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/**
 * The monthly late fee run (LATE10): every hour, each ready organisation
 * that asked for it is charged once a month, from the 1st. Off with
 * TOHYEE_LATE_FEES_SCHEDULER=off. No network calls.
 */
const ACTOR = { userId: null, email: "late-fees@tohyee" };
let running = false;

export async function runOrganisationLateFees(organisation: OrganisationRecord, today?: string): Promise<{ charged: number; failed: number } | null> {
  return withOrganisationTransaction(organisation, ACTOR, async (tx) => {
    // Paused while Accounting is off (MOD6).
    if (!(await accountingEnabled(tx))) return null;
    const exists = await tx.query("select 1 from late_fee_settings where enabled and monthly");
    if (!exists.rowCount) return null;
    const result = await runMonthlyLateFees(tx, today);
    return result ? { charged: result.charged.length, failed: result.failed.length } : null;
  });
}

export async function runDueLateFees(): Promise<{ organisations: number; charged: number; failed: number }> {
  const total = { organisations: 0, charged: 0, failed: 0 };
  if (running) return total;
  running = true;
  try {
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        const done = await runOrganisationLateFees(organisation);
        if (done) {
          total.organisations += 1;
          total.charged += done.charged;
          total.failed += done.failed;
        }
      } catch (error) {
        total.failed += 1;
        console.warn(`[tohyee] Late fees for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return total;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks for a due monthly late fee run every hour while the server runs, and three minutes after it starts. */
export function startLateFeeScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueLateFees().catch((error) => console.warn("[tohyee] Late fee scheduler:", error));
  };
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
