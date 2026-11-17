import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0170",
    name: "income_tax_payment_allocations",
    sql: `
-- Provisional tax payments and where they go (examples ITX6A-ITX6H,
-- decisions 620-623). A payment keeps its bank date (paid_on) and gets
-- IRD's effective date once known. Allocations say which instalment (or the
-- end-of-year tax) a payment or part of one is towards, and how sure that
-- is: confirmed by IRD (from an IRD document), allocated by a person with
-- the evidence they relied on, or a forecast assumption. A payment with no
-- confirmed or evidenced allocation is awaiting reconciliation and counts
-- against no instalment. Reallocating replaces the allocation and keeps the
-- old one with the reason. Nothing posts.
alter table income_tax_payments add column ird_effective_on date;
create table income_tax_payment_allocations (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  payment_id bigint not null references income_tax_payments(id) on delete cascade,
  applies_to text not null check (applies_to in ('instalment_1', 'instalment_2', 'instalment_3', 'end_of_year')),
  amount numeric(18, 2) not null check (amount > 0),
  status text not null check (status in ('confirmed', 'evidenced', 'forecast')),
  basis text not null check (length(basis) between 1 and 300),
  ird_document_id bigint references ird_documents(id),
  check (status <> 'confirmed' or ird_document_id is not null),
  created_by_email text,
  created_at timestamptz not null default now(),
  replaced_at timestamptz,
  replaced_by_email text,
  replaced_reason text check (replaced_reason is null or length(replaced_reason) between 1 and 300),
  check ((replaced_at is null) = (replaced_reason is null))
);
create index income_tax_payment_allocations_payment_idx on income_tax_payment_allocations (payment_id) where replaced_at is null;
`,
  };
