import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0161",
    name: "livestock_reporting",
    sql: `
-- Livestock and the reporting basis (#310 items 2 and 3; LV27, LV28,
-- decisions 566 and 567). Each class is current or non-current (held for
-- sale in the normal operating cycle, NZ IAS 1 para 66); unless chosen,
-- non-current, as before. The current part is moved to its own account by
-- the next valuation approved; approved years aren't re-posted.
alter table livestock_settings
  add column reporting_basis text not null default 'special_purpose' check (reporting_basis in ('special_purpose', 'general_purpose')),
  add column current_asset_account_id bigint references accounts(id);
alter table livestock_settings add constraint livestock_settings_general_purpose_pnl check (reporting_basis = 'special_purpose' or revaluation_target = 'profit_and_loss');
create table livestock_class_reporting (
  kind text not null,
  class_code text not null,
  is_current boolean not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (kind, class_code)
);
`,
  };
