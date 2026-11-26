import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0314",
  name: "sales_platform_cancelled_fulfilments",
  sql: `
-- SPF13-SPF19: a Shopify fulfilment cancelled after Sales when sent counted
-- it is reversed. What counting it did, line by line (the quantity sent and
-- the amount moved out of Income in advance), so the reversal undoes exactly
-- that. Fulfilments counted before this change have no lines here
-- (lines_recorded false) and are reversed at each line's average.
alter table sales_platform_sent add column lines_recorded boolean not null default false;
alter table sales_platform_sent add column reversed_at timestamptz;
alter table sales_platform_sent add column reversed_on date;
alter table sales_platform_sent add column reversal_journal_id bigint references ledger_journals(id);

create table sales_platform_sent_lines (
  id bigserial primary key,
  sent_id bigint not null references sales_platform_sent(id),
  held_line_id bigint not null references sales_platform_held_lines(id),
  quantity numeric(18, 6) not null check (quantity >= 0),
  amount numeric(18, 2) not null,
  unique (sent_id, held_line_id)
);
`,
};
