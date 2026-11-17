import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0092",
    name: "bank_file_feeds",
    sql: `
-- Automatic statement files (BF1-BF10, decisions 385-387): a folder feed reads
-- one subfolder of the organisation's bank files folder (chosen by a server
-- admin); a mailbox feed reads one mailbox folder or Gmail label. Files go
-- through the statement importers; nothing is posted.
create table bank_file_feeds (
  id bigserial primary key,
  account_id bigint not null references accounts(id),
  kind text not null check (kind in ('folder', 'mailbox')),
  subfolder text check (subfolder is null or length(subfolder) between 1 and 255),
  mail_kind text check (mail_kind in ('crm', 'imap')),
  mail_account_id bigint references crm_connected_accounts(id) on delete set null,
  imap_host text check (imap_host is null or length(imap_host) between 1 and 253),
  imap_username text check (imap_username is null or length(imap_username) between 1 and 320),
  imap_password_ciphertext text,
  mail_folder_id text check (mail_folder_id is null or length(mail_folder_id) between 1 and 500),
  mail_folder_name text check (mail_folder_name is null or length(mail_folder_name) between 1 and 500),
  owner_user_id uuid,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  last_check_at timestamptz,
  last_status text check (last_status in ('ok', 'failed')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_files_read integer check (last_files_read >= 0),
  last_lines_added integer check (last_lines_added >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'folder' and subfolder is not null and mail_kind is null and mail_folder_id is null)
    or (kind = 'mailbox' and subfolder is null and mail_kind is not null and mail_folder_id is not null and owner_user_id is not null
        and (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null)))
  )
);
create index bank_file_feeds_account_idx on bank_file_feeds (account_id);

-- What each place has already given an account, kept when a feed is removed
-- so linking the same place again doesn't import old files twice (BF10). A
-- file is seen again only when its contents change (BF3).
create table bank_file_feed_seen (
  account_id bigint not null references accounts(id),
  location text not null check (length(location) between 1 and 1200),
  item_key text not null check (length(item_key) between 1 and 1200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('imported', 'no_new', 'failed')),
  reason text check (reason is null or length(reason) <= 1000),
  import_id bigint references bank_statement_imports(id),
  lines_added integer not null default 0 check (lines_added >= 0),
  seen_at timestamptz not null default now(),
  primary key (account_id, location, item_key, content_hash)
);

alter table bank_statement_imports add column file_feed text check (file_feed in ('folder', 'mailbox'));
`,
  };
