import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0111",
    name: "accounting_module",
    sql: `
-- Accounting as a module that can be off (#181, examples MOD2-MOD7,
-- decision 480). Existing organisations keep it on (MOD7). At least one of
-- Accounting, CRM or Analytics stays on, and Advanced reporting and
-- Not-for-profit need Accounting (MOD5). Turning it off keeps everything.
alter table organisation_settings
  add column accounting_enabled boolean not null default true,
  add constraint organisation_settings_one_app_on check (accounting_enabled or crm_enabled or analytics_enabled),
  add constraint organisation_settings_accounting_extras
    check (accounting_enabled or (not advanced_features and not not_for_profit_enabled));
`,
  };
