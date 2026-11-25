import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0310",
  name: "sales_platform_fixes",
  sql: `
-- SPF5: a full read of a store's orders goes on from here at the next sync
-- (the last updated time read), until a read reaches the end, as long as it
-- still reaches back to the same day (full_read_from). Null when no full
-- read is under way.
alter table sales_platform_connections add column full_read_after timestamptz;
alter table sales_platform_connections add column full_read_from date;

-- SPF6: a line held after it was invoiced (SWS12-SWS14) whose stock already
-- came off with the invoice: the stock item, so a restocked refund of it
-- before it's sent can put the stock back. Null for lines whose stock
-- hasn't left (they're held from the start).
alter table sales_platform_held_lines add column stock_out_item_id bigint references items(id);

-- SPF8: when the sync last read the order again for what it still holds,
-- so every held order gets its turn.
alter table sales_platform_held_lines add column last_read_at timestamptz;
`,
};
