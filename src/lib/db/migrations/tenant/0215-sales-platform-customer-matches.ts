import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0215",
    name: "sales_platform_customer_matches",
    sql: `
-- Same-name customers to check (#539, decisions 1269-1272): a store's
-- customer that wasn't linked or added because an active contact already
-- has the same name and no email settles who they are. Kept so an admin can
-- say "same person" (link to that contact) or "different person" (add a
-- new contact) without fetching the customer again. One row per customer;
-- removed when it's resolved (the sync log and audit trail say how) or
-- when the store is disconnected. Holds what the store said about the
-- customer, as sales_platform_mappings.synced_values does.
create table sales_platform_customer_matches (
  connection_id bigint not null references sales_platform_connections(id),
  external_id text not null check (length(external_id) between 1 and 100),
  name text not null check (length(name) between 1 and 500),
  email text check (email is null or length(email) <= 500),
  phone text check (phone is null or length(phone) <= 100),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  external_updated_at timestamptz,
  -- The existing contact with the same name.
  contact_id bigint not null references contacts(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (connection_id, external_id)
);
`,
  };
