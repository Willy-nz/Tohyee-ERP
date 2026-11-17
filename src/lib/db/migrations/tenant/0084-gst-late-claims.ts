import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0084",
    name: "gst_late_claims",
    sql: `
-- Late claims (examples LG1-LG7, like Xero's): a line dated in an earlier
-- filed return's period that the earlier return didn't count, counted in a
-- later return. late_from_return_id is the filed return it belongs to; null
-- for the return's own period. A line can only be claimed late from a return
-- whose period ends before the claiming return starts.
-- late_reversal: the line takes back off a line the earlier return counted
-- that has since changed or gone (its amounts are that line's, negated).
alter table gst_return_lines add column late_from_return_id bigint references gst_returns(id),
  add column late_reversal boolean not null default false,
  add constraint gst_return_lines_late_reversal_check check (not late_reversal or late_from_return_id is not null);
create index gst_return_lines_late_from_idx on gst_return_lines (late_from_return_id) where late_from_return_id is not null;
`,
  };
