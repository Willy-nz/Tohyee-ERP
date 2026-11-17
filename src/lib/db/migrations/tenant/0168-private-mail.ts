import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0168",
    name: "private_mail",
    sql: `
-- A private copy of an Owner's own mail (#250; examples PM1-PM14,
-- decisions 610-617). It's built on the farm calendar's mailbox connection
-- (one connection and one folder choice per mailbox, #340): only the
-- folders the member ticked are copied, and only for them.

-- Whether the farm calendar reads the mailbox. A mailbox connected from
-- My mail isn't read for the farm calendar unless it's connected there too.
alter table farm_mail_accounts add column farm_calendar boolean not null default true;
-- Where a sign-in was started, so it comes back to the right screen.
alter table farm_mail_states add column purpose text not null default 'calendar' check (purpose in ('calendar', 'private'));
-- Gmail's Sent, Drafts, Spam and Trash can be ticked for the private copy
-- only; the farm calendar never reads them (decision 615).
alter table farm_mail_folders add column private_only boolean not null default false;

-- One private copy per mailbox. owner_user_id never changes (a trigger
-- refuses it): only that member, while an Owner, can read the copy.
-- data_key_ciphertext is the copy's own key, encrypted with the server's
-- TOHYEE_SECRET_KEY (src/lib/secrets); everything below is encrypted with it.
create table private_mail_copies (
  id bigserial primary key,
  owner_user_id uuid not null,
  -- The connection it copies from; null once that's disconnected (the copy
  -- stays until its owner deletes it).
  account_id bigint unique references farm_mail_accounts(id) on delete set null,
  provider text not null check (provider in ('google', 'microsoft')),
  mailbox_email text not null,
  data_key_ciphertext text not null,
  -- The owner's switch: off stops copying and keeps what was copied.
  copying boolean not null default true,
  paused boolean not null default false,
  failures integer not null default 0,
  last_error text,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  -- At the last sync: how many emails the chosen folders had back to the
  -- read-back date, and whether a folder had more than could be listed.
  listed_count integer not null default 0,
  listing_capped boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index private_mail_copies_mailbox on private_mail_copies (owner_user_id, provider, lower(mailbox_email));

-- Each email copied once. The provider's id and the date are plain (for
-- duplicates, order and coverage); everything else is encrypted: envelope
-- (subject, from, to, cc, bcc, snippet, link) and body (the text).
-- thread_key and search_tokens are keyed digests (HMAC) with the copy's
-- key: equal words give equal tokens, but the words can't be read back
-- without the key (decision 613).
create table private_mail_messages (
  id bigserial primary key,
  copy_id bigint not null references private_mail_copies(id) on delete cascade,
  owner_user_id uuid not null,
  external_id text not null,
  thread_key text not null,
  sent_at timestamptz not null,
  -- Which chosen folders (farm_mail_folders ids) it was in at the last sync.
  folder_ids bigint[] not null default '{}',
  envelope bytea not null,
  body bytea not null,
  size_bytes integer not null default 0,
  attachment_count integer not null default 0,
  search_tokens text[] not null default '{}',
  -- Deleted (or put in the bin) in Gmail or Outlook: the copy keeps it, marked so
  -- (decision 616, Codex, delegated by owner, 20 October 2026).
  source_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (copy_id, external_id)
);
create index private_mail_messages_copy_sent on private_mail_messages (copy_id, sent_at desc, id desc);
create index private_mail_messages_thread on private_mail_messages (copy_id, thread_key);
create index private_mail_messages_search on private_mail_messages using gin (search_tokens);

-- Attachments: name and type encrypted in meta, the file encrypted in
-- content (null when it was too big to keep or is a linked item).
create table private_mail_attachments (
  id bigserial primary key,
  message_id bigint not null references private_mail_messages(id) on delete cascade,
  copy_id bigint not null references private_mail_copies(id) on delete cascade,
  owner_user_id uuid not null,
  external_id text not null,
  meta bytea not null,
  content bytea,
  size_bytes integer not null default 0,
  created_at timestamptz not null default now(),
  unique (message_id, external_id)
);
create index private_mail_attachments_copy on private_mail_attachments (copy_id);

-- Ownership never changes, and rows always belong to their copy's owner.
create function private_mail_copy_owner_fixed() returns trigger language plpgsql as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'A private mail copy''s owner can''t change.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create function private_mail_row_owner_fixed() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'A private mail copy''s owner can''t change.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from private_mail_copies c where c.id = new.copy_id and c.owner_user_id = new.owner_user_id) then
    raise exception 'A private mail row must belong to its copy''s owner.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger private_mail_copies_owner before update on private_mail_copies for each row execute function private_mail_copy_owner_fixed();
create trigger private_mail_messages_owner before insert or update on private_mail_messages for each row execute function private_mail_row_owner_fixed();
create trigger private_mail_attachments_owner before insert or update on private_mail_attachments for each row execute function private_mail_row_owner_fixed();
`,
  };
