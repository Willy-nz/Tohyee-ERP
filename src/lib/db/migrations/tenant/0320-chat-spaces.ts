import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0320",
    name: "chat_spaces",
    sql: `
-- Chat's direct messages and spaces (examples TCH10-TCH26). A room is
-- Everyone (the old team chat, one only), a named space, or a direct message
-- between a fixed set of people. Room ids are random, so one says nothing
-- about another.
create table chat_rooms (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('everyone', 'space', 'direct')),
  name text check (name is null or char_length(name) between 1 and 80),
  -- A direct message's people, as their sorted ids: the same people always
  -- open the same chat (TCH12).
  people_key text unique,
  created_by_user_id text,
  created_by_email text,
  idempotency_key text unique,
  request_hash text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by_email text,
  check ((kind = 'direct') = (people_key is not null)),
  check (kind = 'direct' or name is not null),
  check ((closed_at is null) = (closed_by_email is null)),
  -- Only a space can be closed (TCH13, TCH16).
  check (kind = 'space' or closed_at is null)
);
create unique index chat_rooms_one_everyone on chat_rooms (kind) where kind = 'everyone';
create unique index chat_rooms_open_space_name on chat_rooms (lower(name)) where kind = 'space' and closed_at is null;
insert into chat_rooms (kind, name) values ('everyone', 'Everyone');

-- Who's in a space or direct message. Everyone has no rows: it's everyone
-- in Chat (TCH6, TCH11). The email is kept to name someone who has left the
-- organisation.
create table chat_room_members (
  room_id uuid not null references chat_rooms(id),
  user_id text not null,
  user_email text not null,
  added_by_email text not null,
  added_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index chat_room_members_user on chat_room_members (user_id);

-- Messages stay in the one table: each is in a farm's chat or in a room.
alter table farm_chat_messages add column room_id uuid references chat_rooms(id);
update farm_chat_messages set room_id = (select id from chat_rooms where kind = 'everyone') where farm_id is null;
alter table farm_chat_messages add constraint farm_chat_messages_one_place check ((farm_id is null) <> (room_id is null));
create index farm_chat_messages_room on farm_chat_messages (room_id, id) where room_id is not null;
drop index farm_chat_messages_team_idx;

-- How far each person has read each room (TCH10). The team chat's reads
-- become Everyone's.
create table chat_room_reads (
  room_id uuid not null references chat_rooms(id),
  user_id text not null,
  read_up_to bigint not null,
  primary key (room_id, user_id)
);
insert into chat_room_reads (room_id, user_id, read_up_to)
  select (select id from chat_rooms where kind = 'everyone'), user_id, read_up_to from team_chat_reads;
drop table team_chat_reads;

-- Who a message mentions (TCH18). Taking the message down removes these.
create table chat_mentions (
  message_id bigint not null references farm_chat_messages(id) on delete cascade,
  user_id text not null,
  primary key (message_id, user_id)
);
create index chat_mentions_user on chat_mentions (user_id, message_id desc);
`,
};
