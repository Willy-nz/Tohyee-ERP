import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0113",
    name: "gocardless_direct_debit",
    sql: `
-- Direct debit with GoCardless, BECS NZ (stage 10 of the add-ons plan,
-- examples GC1-GC10, decision 482). One connection per organisation: the
-- organisation's own GoCardless access token, stored encrypted.
create table gocardless_settings (
  id boolean primary key default true check (id),
  environment text not null default 'live' check (environment in ('live', 'sandbox')),
  access_token_ciphertext text,
  creditor_name text,
  enabled boolean not null default false,
  -- Where collected money waits until GoCardless pays it out (GC4, GC5), the bank account it's paid into, and the fees.
  clearing_account_id bigint references accounts(id),
  payout_account_id bigint references accounts(id),
  fees_account_id bigint references accounts(id),
  connected_at timestamptz,
  connected_by_email text,
  last_check_at timestamptz,
  last_check_status text check (last_check_status in ('ok', 'failed')),
  last_check_error text check (last_check_error is null or length(last_check_error) <= 1000),
  lease_until timestamptz,
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check (not enabled or (access_token_ciphertext is not null and clearing_account_id is not null and payout_account_id is not null
                         and fees_account_id is not null))
);
insert into gocardless_settings (id) values (true);

-- A customer's direct debit authority (mandate, GC2, GC7): asked for with a
-- GoCardless page the customer fills in; one current per contact.
create table gocardless_authorities (
  id bigserial primary key,
  contact_id bigint not null references contacts(id),
  billing_request_id text not null unique check (length(billing_request_id) between 1 and 100),
  flow_url text check (flow_url is null or (flow_url ~ '^https://' and length(flow_url) <= 1000)),
  flow_expires_at timestamptz,
  mandate_id text unique check (mandate_id is null or length(mandate_id) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'active', 'ended')),
  provider_status text,
  next_possible_charge_date date,
  ended_reason text check (ended_reason is null or length(ended_reason) <= 500),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index gocardless_authorities_one_current on gocardless_authorities (contact_id) where status in ('pending', 'active');

-- Each collection asked of GoCardless for an invoice (GC3-GC9).
create table gocardless_collections (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
  authority_id bigint not null references gocardless_authorities(id),
  provider_payment_id text not null unique check (length(provider_payment_id) between 1 and 100),
  amount numeric not null check (amount > 0),
  charge_date date,
  status text not null check (status in ('scheduled', 'confirmed', 'failed', 'cancelled')),
  provider_status text,
  -- The customer payment recorded for it (GC4), voided again if it fails later (GC6).
  customer_payment_id bigint references customer_payments(id),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 500),
  retries integer not null default 0 check (retries between 0 and 3),
  notice text check (notice is null or length(notice) <= 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index gocardless_collections_one_open on gocardless_collections (invoice_id) where status = 'scheduled';

-- "Don't collect this one" on an invoice.
create table gocardless_invoice_skips (
  invoice_id bigint primary key references sales_invoices(id) on delete cascade,
  created_by_email text,
  created_at timestamptz not null default now()
);

-- Each GoCardless payout posted (GC5): collected money and fees out of the clearing account.
create table gocardless_payouts (
  id bigserial primary key,
  payout_id text not null unique check (length(payout_id) between 1 and 100),
  amount numeric not null,
  fees numeric not null,
  arrival_date date not null,
  reference text,
  journal_id bigint references ledger_journals(id),
  created_at timestamptz not null default now()
);
`,
  };
