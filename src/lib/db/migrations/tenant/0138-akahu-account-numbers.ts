import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0138",
    name: "akahu_account_numbers",
    sql: `
-- A joint account seen through two people's Akahu logins (#257, BK36): the
-- bank account number Akahu reports, as digits, so the same account can't be
-- linked twice even when the two logins give it different Akahu ids.
alter table bank_account_settings add column akahu_account_number text
  check (akahu_account_number is null or akahu_account_number ~ '^[0-9]{6,34}$');
create unique index bank_account_settings_akahu_number on bank_account_settings (akahu_account_number) where akahu_account_number is not null;
`,
  };
