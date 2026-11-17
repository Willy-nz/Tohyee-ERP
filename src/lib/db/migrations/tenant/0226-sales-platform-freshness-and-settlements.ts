import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0226",
    name: "sales_platform_freshness_and_settlements",
    sql: `
-- #572: the last sync that worked, apart from the last attempt
-- (last_sync_at is set by failed syncs too). Filled from what's known: a
-- connection with no failures last synced fine; for one that's failing,
-- the newest "Synced ..." summary line in its log (a sync that changed
-- nothing logs none, so this can be earlier than the real last success).
alter table sales_platform_connections add column last_successful_sync_at timestamptz;
update sales_platform_connections c
   set last_successful_sync_at = case
         when c.failures = 0 then c.last_sync_at
         else (select max(l.logged_at) from sales_platform_sync_log l
                where l.connection_id = c.id and l.action = 'sync' and l.message like 'Synced %')
       end;

-- Settlements kept before the payout's own TRANSFER row was left out
-- (SPC38): that row was counted under "other", so other is the payout the
-- other way round and the settlement doesn't add up. Where the other parts
-- come to the payout exactly, the row is taken out again. The payout is
-- read again at the next sync anyway when it isn't in the accounts.
update sales_platform_payouts p
   set other_amounts = 0, transaction_count = greatest(coalesce(p.transaction_count, 1) - 1, 0)
 where p.detail_read and p.other_amounts <> 0
   and p.other_amounts = -(case when p.direction = 'WITHDRAWAL' then -abs(p.net) else abs(p.net) end)
   and p.gross_sales + p.refunds + p.fees + p.adjustments + p.chargebacks + p.reserves
       = (case when p.direction = 'WITHDRAWAL' then -abs(p.net) else abs(p.net) end);
`,
  };
