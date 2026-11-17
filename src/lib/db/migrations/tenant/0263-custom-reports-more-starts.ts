import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0263",
    name: "custom_reports_more_starts",
    sql: `
-- A custom report can start from the rest of the standard reports (CRS1):
-- trial balance, stock valuation, bank reconciliation, budget vs actual and
-- changes in equity. 0262 already lists them, so this is the same check
-- again, in case 0262 ran on an earlier version without them.
alter table custom_reports drop constraint custom_reports_base_check;
alter table custom_reports add constraint custom_reports_base_check
  check (base in ('profit_and_loss', 'balance_sheet', 'cash_flows', 'account_transactions', 'aged_receivables', 'aged_payables', 'sales_by_salesperson', 'journal_report',
                  'trial_balance', 'inventory_valuation', 'bank_reconciliation', 'budget_vs_actual', 'changes_in_equity'));
`,
  };
