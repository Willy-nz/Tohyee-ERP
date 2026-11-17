import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0098",
    name: "online_payments",
    sql: `
-- Online invoice payments with Stripe (PN1-PN12, decisions 414-419): whether
-- an admin turned "Pay now" on, and the lease for checking payments.
create table online_payment_settings (
  provider text primary key check (provider in ('stripe')),
  enabled boolean not null default false,
  last_check_at timestamptz,
  last_check_status text check (last_check_status in ('ok', 'failed')),
  last_check_error text check (last_check_error is null or length(last_check_error) <= 1000),
  lease_until timestamptz,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- An invoice can leave "Pay now" off (question 5).
create table invoice_payment_options (
  invoice_id bigint primary key references sales_invoices(id) on delete cascade,
  pay_now boolean not null,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- Each Stripe payment link made for an invoice, for its amount due then. One
-- is open at a time; a link whose amount no longer matches is switched off.
create table invoice_payment_links (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  provider_link_id text not null unique check (length(provider_link_id) between 1 and 200),
  url text not null check (url ~ '^https://' and length(url) <= 1000),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric not null check (amount > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason is null or length(closed_reason) <= 200),
  close_pending boolean not null default false,
  created_by_email text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'closed') = (closed_at is not null))
);
create unique index invoice_payment_links_one_open on invoice_payment_links (invoice_id) where status = 'open';

-- Each completed Stripe checkout session seen: recorded as a customer
-- payment, or left as a notice for a person (PN10, a missing balance link).
create table online_payments (
  id bigserial primary key,
  provider text not null default 'stripe' check (provider in ('stripe')),
  session_id text not null unique check (length(session_id) between 1 and 300),
  link_id bigint references invoice_payment_links(id),
  invoice_id bigint references sales_invoices(id) on delete set null,
  provider_payment_id text,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric not null check (amount > 0),
  paid_date date not null,
  -- What reached Stripe's balance: its currency, amount and balance transaction.
  settled_currency text check (settled_currency is null or settled_currency ~ '^[A-Z]{3}$'),
  settled_amount numeric,
  -- A notice that's tried again at each check: no bank account was linked to that balance yet.
  waiting_for_link boolean not null default false,
  status text not null check (status in ('recorded', 'notice')),
  payment_id bigint references customer_payments(id),
  notice text check (notice is null or length(notice) <= 1000),
  dismissed_at timestamptz,
  dismissed_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'recorded') = (payment_id is not null)),
  check (status = 'recorded' or notice is not null)
);
create index online_payments_invoice_idx on online_payments (invoice_id);
`,
  };
