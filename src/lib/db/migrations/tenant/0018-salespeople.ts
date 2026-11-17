import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0018",
    name: "salespeople",
    sql: `
-- Salespeople (examples SR1-SR8): a customer's default salesperson, and one
-- salesperson on each sales invoice and sales credit note. Never changes an
-- amount; archived, never deleted.
create table salespeople (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  email text check (email is null or length(email) between 3 and 254),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index salespeople_name_idx on salespeople (lower(name));

create function tohyee_guard_salesperson() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'salespeople can''t be truncated' using errcode = 'P0001';
  end if;
  raise exception 'Salespeople can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;
create trigger salespeople_guard before delete on salespeople
  for each row execute function tohyee_guard_salesperson();
create trigger salespeople_no_truncate before truncate on salespeople
  for each statement execute function tohyee_guard_salesperson();

alter table contacts add column default_salesperson_id bigint references salespeople(id);
alter table sales_invoices add column salesperson_id bigint references salespeople(id);
alter table sales_credit_notes add column salesperson_id bigint references salespeople(id);
create index sales_invoices_salesperson_idx on sales_invoices (salesperson_id);
create index sales_credit_notes_salesperson_idx on sales_credit_notes (salesperson_id);
`,
  };
