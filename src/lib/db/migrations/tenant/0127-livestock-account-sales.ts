import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0127",
    name: "livestock_account_sales",
    sql: `
-- Stock agent account sales (examples LV13-LV16 approved by Jess 11 Oct
-- 2026, decision 506). The agent's account sale is the farmer's tax
-- invoice: it's kept as an invoice to the agent for the sales, a bill from
-- the agent for the deductions, and a contra settling the bill against the
-- invoice, so the agent owes the net and GST returns see both sides. No
-- foreign keys to the documents, which guard against truncation.
create table livestock_account_sales (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  contact_id bigint not null,
  reference text not null check (length(reference) between 1 and 100),
  sale_date date not null,
  invoice_id bigint not null,
  bill_id bigint,
  customer_payment_id bigint,
  supplier_payment_id bigint,
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_email text,
  void_reason text,
  unique (command_source, idempotency_key)
);
create unique index livestock_account_sales_reference on livestock_account_sales (contact_id, lower(reference)) where status = 'active';

-- Management values per head (LV18-LV20, decision 506): the farm's own
-- assumptions by class, from a month on. They never touch tax values or post.
create table livestock_management_values (
  kind text not null,
  class_code text not null,
  effective_month date not null check (extract(day from effective_month) = 1),
  amount numeric(12, 2) not null check (amount >= 0),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  primary key (kind, class_code, effective_month)
);

-- Beef males under NSC add a rising 3-year cost before joining the mature group (LV17, decision 506).
insert into livestock_rates (income_year, rate_kind, kind, category, amount, source, entered_by_email)
values (2026, 'nsc', 'beef_cattle', 'rising_3_male', 251.00,
        'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026',
        'tohyee')
on conflict (income_year, rate_kind, kind, category) do nothing;
`,
  };
