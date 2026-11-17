import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0264",
    name: "equity_layouts",
    sql: `
-- Changes in equity can have a default layout too (CEL5).
alter table report_layout_defaults drop constraint report_layout_defaults_base_check;
alter table report_layout_defaults add constraint report_layout_defaults_base_check check (base in ('profit_and_loss', 'balance_sheet', 'cash_flows', 'changes_in_equity'));
`,
  };
