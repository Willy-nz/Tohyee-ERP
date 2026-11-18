import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";

/**
 * The modules chosen when an organisation is created (MOD2-MOD4):
 * Accounting, Tax (registered for GST), CRM and Analytics. Left
 * out, a module takes its usual default (Accounting on, CRM and Analytics
 * off). GST registration (GSR1-GSR2) is `true` (registered, confirmed),
 * `false` (not registered, confirmed) or `"unsure"` (not registered for now,
 * so nothing charges GST, but not confirmed: Settings asks the owner). Left
 * out, it stays Tohyee's unconfirmed starting guess (NR8: registered).
 */
export type GstChoice = boolean | "unsure";
export type InitialModules = { accounting: boolean; gstRegistered: GstChoice | null; crm: boolean; analytics: boolean; payroll: boolean };

export function parseInitialModules(input: unknown): InitialModules | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("modules must be an object.");
  const record = input as Record<string, unknown>;
  const flag = (name: "accounting" | "crm" | "analytics" | "payroll", fallback: boolean) => {
    const value = record[name];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new ValidationError(`modules.${name} must be true or false.`);
    return value;
  };
  const gst = record.gstRegistered;
  if (gst !== undefined && gst !== null && typeof gst !== "boolean" && gst !== "unsure") {
    throw new ValidationError('modules.gstRegistered must be true, false or "unsure".');
  }
  const accounting = flag("accounting", true);
  // Payroll starts on with Accounting, as it always has, and can be chosen on its own (PAO1).
  const modules = { accounting, gstRegistered: (gst ?? null) as GstChoice | null, crm: flag("crm", false), analytics: flag("analytics", false), payroll: flag("payroll", accounting) };
  if (!modules.accounting && !modules.crm && !modules.analytics && !modules.payroll) throw new ValidationError("Keep at least one of Accounting, Payroll, CRM or Analytics on.");
  return modules;
}

/** The settings change for a GST choice at creation (GSR1-GSR2). */
export function gstChoiceSettings(choice: GstChoice | null): { gstRegistered?: boolean; gstRegistrationConfirmed?: boolean } {
  if (choice === null) return {};
  if (choice === "unsure") return { gstRegistered: false, gstRegistrationConfirmed: false };
  return { gstRegistered: choice, gstRegistrationConfirmed: true };
}

/** Sets a new organisation's modules once its database is ready, as its first owner. */
export async function applyInitialModules(organisation: OrganisationRecord, modules: InitialModules, actor: { userId: string; email: string }): Promise<void> {
  await withOrganisationTransaction(organisation, actor, (tx) =>
    updateOrganisationSettings(tx, {
      // CRM and Analytics first, so Accounting can go off in the same change (MOD5).
      crmEnabled: modules.crm,
      analyticsEnabled: modules.analytics,
      payrollEnabled: modules.payroll,
      accountingEnabled: modules.accounting,
      // A new organisation has no GST number yet and starts registered, so "registered" is a confirmation alone (NR8, GSR1).
      ...gstChoiceSettings(modules.gstRegistered),
    }),
  );
}
