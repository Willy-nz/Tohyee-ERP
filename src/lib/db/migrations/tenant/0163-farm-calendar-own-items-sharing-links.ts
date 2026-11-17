import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0163",
    name: "farm_calendar_own_items_sharing_links",
    sql: `
-- The farm calendar's own items, repeats, sharing and calendar link
-- (FC17-FC23, decisions 573-575). Each item now names its member, so items
-- people add (no mailbox) are theirs too.
alter table farm_calendar_items
  add column user_id uuid,
  add column source text not null default 'email' check (source in ('email', 'own')),
  add column notes text check (notes is null or length(notes) <= 2000),
  add column repeat text check (repeat in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  add column repeat_until date,
  add column repeat_skips date[] not null default '{}',
  add column shared_at timestamptz,
  add column shared_by_name text;
update farm_calendar_items i set user_id = a.user_id from farm_mail_accounts a where a.id = i.account_id;
alter table farm_calendar_items
  alter column user_id set not null,
  alter column account_id drop not null,
  alter column external_id drop not null,
  alter column sent_at drop not null,
  alter column sender_email drop not null,
  alter column excerpt drop not null,
  drop constraint farm_calendar_items_kind_check,
  add constraint farm_calendar_items_kind_check check (kind in ('animal_health', 'delivery', 'stock_movement', 'contractor', 'deadline', 'meeting', 'other')),
  add constraint farm_calendar_items_source_fields check (
    (source = 'email' and account_id is not null and external_id is not null and sent_at is not null and sender_email is not null and excerpt is not null)
    or (source = 'own' and account_id is null)),
  add constraint farm_calendar_items_repeat_date check (repeat is null or item_date is not null),
  add constraint farm_calendar_items_repeat_until check (repeat_until is null or (repeat is not null and repeat_until >= item_date)),
  add constraint farm_calendar_items_shared_by check (shared_at is null or shared_by_name is not null);
create index farm_calendar_items_user_date on farm_calendar_items (user_id, item_date);
create index farm_calendar_items_shared on farm_calendar_items (item_date) where shared_at is not null;

-- One private calendar link per member (FC22): only a hash of it is kept.
create table farm_calendar_links (
  user_id uuid primary key,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
`,
  };
