import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0294",
    name: "team_chat",
    sql: `
-- Team chat (examples TCH1-TCH9): one chat for the whole organisation, its
-- own app, switched on in Settings, Modules. Its messages are kept with the
-- farm chats' messages, with no farm; they have words, photos and voice
-- notes, and no links.
create table team_chat_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into team_chat_settings (id) values (true);

alter table farm_chat_messages alter column farm_id drop not null;
create index farm_chat_messages_team_idx on farm_chat_messages (id) where farm_id is null;

-- How far each person has read the team chat (TCH5).
create table team_chat_reads (
  user_id text primary key,
  read_up_to bigint not null
);
`,
};
