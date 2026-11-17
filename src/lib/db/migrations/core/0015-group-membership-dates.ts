import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0015",
    name: "group_membership_dates",
    sql: `
-- Group workspace (#200, decisions 640-643; Codex, delegated by owner, 20
-- October 2026). Each stay of an organisation in a group is a row with the
-- day it joined and the last day it was in (null: from the start, still in
-- it), so a member can leave and come back and reports know who was in the
-- group on a date. The steward is the member organisation whose own
-- database holds the group's new business records (customer links, stage
-- mappings, saved reports); the core database only says which one it is.
alter table consolidation_group_members drop constraint consolidation_group_members_pkey;
alter table consolidation_group_members add column id bigserial primary key;
alter table consolidation_group_members add column effective_from date;
alter table consolidation_group_members add column effective_to date;
alter table consolidation_group_members add column ended_by_email text;
alter table consolidation_group_members add column ended_at timestamptz;
alter table consolidation_group_members add constraint consolidation_group_members_dates
  check (effective_from is null or effective_to is null or effective_to >= effective_from);
create unique index consolidation_group_members_open on consolidation_group_members (group_id, organisation_id) where effective_to is null;
create index consolidation_group_members_group on consolidation_group_members (group_id);
alter table consolidation_groups add column steward_organisation_id text references organisations(id);
`,
  };
