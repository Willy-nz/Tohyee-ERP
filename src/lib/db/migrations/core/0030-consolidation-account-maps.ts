import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0030",
    name: "consolidation_account_maps",
    sql: `
-- Chart mapping (CO16): in a group, a member's account can go to one of the
-- parent's accounts, so organisations with different charts add up on the
-- parent's lines. Account ids are each organisation's own (no foreign key
-- reaches into its database); a map whose account has gone is ignored.
create table consolidation_account_maps (
  group_id bigint not null references consolidation_groups(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  account_id bigint not null check (account_id > 0),
  parent_account_id bigint not null check (parent_account_id > 0),
  changed_by_email text not null,
  changed_at timestamptz not null default now(),
  primary key (group_id, organisation_id, account_id)
);
`,
  };
