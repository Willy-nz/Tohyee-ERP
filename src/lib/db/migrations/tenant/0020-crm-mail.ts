import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0020",
    name: "crm_mail",
    sql: `
-- CRM email and calendar sync (examples MAIL1-MAIL9). The organisation's own
-- Google and Microsoft app, each member's connected mailbox, and the emails
-- and meetings kept because a known person or company took part.
create table crm_mail_settings (
  id boolean primary key default true check (id),
  google_client_id text,
  google_client_secret_ciphertext text,
  microsoft_client_id text,
  microsoft_client_secret_ciphertext text,
  microsoft_tenant text not null default 'common',
  updated_at timestamptz not null default now()
);
insert into crm_mail_settings (id) values (true);

create table crm_oauth_states (
  state text primary key,
  user_id text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table crm_connected_accounts (
  id bigserial primary key,
  user_id text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  visibility text not null default 'subject' check (visibility in ('subject', 'metadata')),
  status text not null default 'active' check (status in ('active', 'paused')),
  messages_synced_until timestamptz,
  calendar_synced_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_connected_accounts_email_idx on crm_connected_accounts (provider, lower(email));

create table crm_messages (
  id bigserial primary key,
  account_id bigint not null references crm_connected_accounts(id) on delete cascade,
  external_id text not null,
  thread_id text,
  direction text not null check (direction in ('sent', 'received')),
  sent_at timestamptz not null,
  from_email text not null,
  from_name text,
  to_emails text[] not null default '{}',
  subject text,
  preview text check (preview is null or length(preview) <= 300),
  created_at timestamptz not null default now(),
  unique (account_id, external_id)
);

create table crm_calendar_events (
  id bigserial primary key,
  account_id bigint not null references crm_connected_accounts(id) on delete cascade,
  external_id text not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  attendee_emails text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, external_id)
);

-- Who each email or meeting was with: a CRM person and/or a company.
create table crm_participant_links (
  id bigserial primary key,
  message_id bigint references crm_messages(id) on delete cascade,
  event_id bigint references crm_calendar_events(id) on delete cascade,
  person_id bigint references crm_people(id),
  contact_id bigint references contacts(id),
  check ((message_id is null) <> (event_id is null)),
  check (person_id is not null or contact_id is not null)
);
create index crm_participant_links_contact_idx on crm_participant_links (contact_id);
create index crm_participant_links_person_idx on crm_participant_links (person_id);
create index crm_participant_links_message_idx on crm_participant_links (message_id);
create index crm_participant_links_event_idx on crm_participant_links (event_id);
`,
  };
