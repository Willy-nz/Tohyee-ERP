import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0262",
    name: "cash_flow_layouts",
    sql: `
-- Cash flow layouts (examples CFL1-CFL5): a custom report can start from the
-- statement of cash flows, and be the default layout for it. The list also has
-- 0263's report types (CRS1), so the two can run in either order.
alter table custom_reports drop constraint custom_reports_base_check;
alter table custom_reports add constraint custom_reports_base_check
  check (base in ('profit_and_loss', 'balance_sheet', 'cash_flows', 'account_transactions', 'aged_receivables', 'aged_payables', 'sales_by_salesperson', 'journal_report',
                  'trial_balance', 'inventory_valuation', 'bank_reconciliation', 'budget_vs_actual', 'changes_in_equity'));
alter table report_layout_defaults drop constraint report_layout_defaults_base_check;
alter table report_layout_defaults add constraint report_layout_defaults_base_check check (base in ('profit_and_loss', 'balance_sheet', 'cash_flows'));
`,
  };
