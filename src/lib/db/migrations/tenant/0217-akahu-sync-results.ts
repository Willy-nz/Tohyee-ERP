import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0217",
    name: "akahu_sync_results",
    sql: `
-- Guided Akahu setup and clearer feed statuses (#543, decisions 1288-1291).
-- When a login's tokens last worked (saved after Akahu checked them, or a
-- sync that Akahu answered), and each linked account's last successful sync
-- and how many new lines it brought in, so "synced, nothing new" can be told
-- apart from "never synced" and a failure doesn't hide the last success.
alter table akahu_connections add column tokens_checked_at timestamptz;
update akahu_connections set tokens_checked_at = created_at;
alter table bank_account_settings
  add column last_sync_ok_at timestamptz,
  add column last_sync_added integer check (last_sync_added is null or last_sync_added >= 0);
update bank_account_settings set last_sync_ok_at = last_synced_at where last_sync_status = 'ok';
`,
  };
