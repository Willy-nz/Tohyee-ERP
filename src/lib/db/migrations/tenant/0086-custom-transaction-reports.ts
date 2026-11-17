import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0086",
    name: "custom_transaction_reports",
    sql: `
alter table custom_reports drop constraint custom_reports_base_check;
alter table custom_reports add constraint custom_reports_base_check
  check (base in ('profit_and_loss', 'balance_sheet', 'account_transactions', 'aged_receivables', 'aged_payables', 'sales_by_salesperson', 'journal_report'));
`,
  };
