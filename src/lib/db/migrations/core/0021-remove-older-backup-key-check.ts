import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0021",
    name: "remove_older_backup_key_check",
    sql: `
-- The older backup key (format 1 backups, before recovery kits) was removed
-- before anyone used Tohyee (#440, decision 867). Its saved-copy check was
-- the only thing kept in this setting. Its audit events stay as history.
delete from server_settings where key = 'backup_key';
`,
  };
