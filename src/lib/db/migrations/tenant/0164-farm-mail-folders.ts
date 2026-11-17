import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0164",
    name: "farm_mail_folders",
    sql: `
-- Which folders (Outlook) or labels (Gmail) a farm mailbox reads (#340;
-- FC25-FC30, decisions 584-586). Nothing is read until at least one is
-- chosen, so mailboxes connected before this stop until their member
-- chooses. Folder names are the member's private metadata (decision 571).
create table farm_mail_folders (
  id bigserial primary key,
  account_id bigint not null references farm_mail_accounts(id) on delete cascade,
  external_id text not null,
  name text not null,
  include_subfolders boolean not null default false,
  -- Not found in the mailbox at the last check (deleted or renamed away).
  missing boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, external_id)
);

-- Which chosen folders each email read was in: only ids (FC27, FC28).
alter table farm_mail_seen add column folder_ids bigint[] not null default '{}';

-- What an email did to an earlier item, so it can be undone when the email
-- is dropped (FC28): the email that cancelled it, and the other emails
-- that mentioned the same thing (FC9). Only email ids.
alter table farm_calendar_items
  add column cancelled_by_external_id text,
  add column also_seen_external_ids text[] not null default '{}';
`,
  };
