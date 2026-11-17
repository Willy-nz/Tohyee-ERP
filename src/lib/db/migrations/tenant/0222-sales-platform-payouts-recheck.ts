import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0222",
    name: "sales_platform_payouts_recheck",
    sql: `
-- Payouts to read again at the next sync (examples SPC38-SPC41, decisions
-- 1326-1333). The first live store's payouts were all refused (their own
-- TRANSFER row, a withdrawal) and the cursor moved past them. Every paid
-- payout not in the accounts is looked at once more; reading it again
-- clears the flag, and "Try again" on the store sets it. A payout already
-- posted is skipped by its sales_platform_documents row, so none is posted
-- twice.
alter table sales_platform_payouts add column recheck boolean not null default false;
update sales_platform_payouts p set recheck = true
 where p.status = 'PAID'
   and not exists (select 1 from sales_platform_documents d
                    where d.platform = p.platform and d.store_domain = p.store_domain and d.record_kind = 'payout' and d.external_id = p.external_id);
create index sales_platform_payouts_recheck_idx on sales_platform_payouts (connection_id, issued_on) where recheck;
`,
  };
