import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0292",
    name: "farm_chat",
    sql: `
-- Farm chat (examples FCH1-FCH9): one chat per farm, for everyone who can
-- see the farm. A message keeps who posted it, and whether their AI posted
-- it for them. Taking a message down keeps that it was there, not what it said.
create table farm_chat_messages (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  body text not null default '' check (char_length(body) <= 4000),
  posted_by_user_id text,
  posted_by_email text not null,
  via_ai boolean not null default false,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((removed_at is null) = (removed_by_email is null))
);
create index farm_chat_messages_farm on farm_chat_messages (farm_id, created_at desc);

-- Photos (and later voice notes) on a message, kept in the organisation's database like paddock photos.
create table farm_chat_attachments (
  id bigserial primary key,
  message_id bigint not null references farm_chat_messages(id) on delete cascade,
  kind text not null check (kind in ('photo', 'voice')),
  file_name text not null,
  content_type text not null,
  bytes integer not null check (bytes > 0),
  content bytea not null
);
create index farm_chat_attachments_message on farm_chat_attachments (message_id);

-- What a message is about: it shows on that paddock, mob or task too.
create table farm_chat_links (
  message_id bigint not null references farm_chat_messages(id) on delete cascade,
  kind text not null check (kind in ('paddock', 'mob', 'task')),
  record_id bigint not null,
  primary key (message_id, kind, record_id)
);
create index farm_chat_links_record on farm_chat_links (kind, record_id);

-- How far each person has read each farm's chat, for unread counts.
create table farm_chat_reads (
  user_id text not null,
  farm_id bigint not null references farms(id),
  read_up_to bigint not null,
  primary key (user_id, farm_id)
);
`,
};
