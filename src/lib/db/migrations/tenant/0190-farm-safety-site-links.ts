import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0190",
    name: "farm_safety_site_links",
    sql: `
-- A farm's sign-in link (#446, decisions 948-952): a QR code at the gate
-- for visitors and contractors without a Tohyee login. The random token in
-- the address is the only key (kept here as its hash); it shows that farm's
-- hazards, emergency details and visitor induction, and takes a sign-in.
-- It never shows who else is on site, or any report. Turned off by setting
-- turned_off_at; links aren't deleted.
create table safety_site_links (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_on date,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  turned_off_at timestamptz,
  turned_off_by_email text,
  last_used_at timestamptz
);
-- Signing out from the same phone: each sign-in through a link gets its own
-- random sign-out token (hash kept), used once.
create table safety_site_checkouts (
  visit_record_id uuid primary key,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
`,
  };
