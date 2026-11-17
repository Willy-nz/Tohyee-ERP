import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0021",
    name: "richer_customers",
    sql: `
-- Richer customers (examples RC1-RC12), NetSuite's customer detail.
-- Payment terms are for every organisation (like Xero's); the rest shows
-- while Advanced reporting is on. Lists are archived, never deleted.

-- Payment terms (RC1, RC2): N days after the invoice date, N days after the
-- end of the invoice's month, or day N of the following month.
create table payment_terms (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  kind text not null check (kind in ('days_after_invoice', 'days_after_month_end', 'day_of_next_month')),
  days integer not null check (days between 0 and 365),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'day_of_next_month' or days between 1 and 31)
);
create unique index payment_terms_name_idx on payment_terms (lower(name));
create trigger payment_terms_no_delete before delete on payment_terms for each row execute function toeyee_forbid_delete();
create trigger payment_terms_no_truncate before truncate on payment_terms for each statement execute function toeyee_forbid_delete();
insert into payment_terms (name, kind, days) values
  ('Due on receipt', 'days_after_invoice', 0),
  ('7 days', 'days_after_invoice', 7),
  ('14 days', 'days_after_invoice', 14),
  ('30 days', 'days_after_invoice', 30),
  ('20th of the following month', 'day_of_next_month', 20),
  ('30 days after the end of the month', 'days_after_month_end', 30);

-- Customer groups (RC7), like NetSuite's customer categories.
create table customer_groups (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customer_groups_name_idx on customer_groups (lower(name));
create trigger customer_groups_no_delete before delete on customer_groups for each row execute function toeyee_forbid_delete();
create trigger customer_groups_no_truncate before truncate on customer_groups for each statement execute function toeyee_forbid_delete();

-- Price levels (RC7), like NetSuite's: a percent off (negative) or on
-- (positive) the base price. Item prices come with items; nothing uses the
-- percent yet.
create table price_levels (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  markup_percent numeric not null check (markup_percent > -100 and markup_percent <= 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index price_levels_name_idx on price_levels (lower(name));
create trigger price_levels_no_delete before delete on price_levels for each row execute function toeyee_forbid_delete();
create trigger price_levels_no_truncate before truncate on price_levels for each statement execute function toeyee_forbid_delete();

-- The existing postal address is the billing address (RC6).
comment on column contacts.postal_address is 'The billing address (RC6)';
alter table contacts
  add column delivery_address text check (delivery_address is null or length(delivery_address) between 1 and 500),
  add column payment_term_id bigint references payment_terms(id),
  add column credit_limit numeric check (credit_limit is null or credit_limit >= 0),
  add column customer_group_id bigint references customer_groups(id),
  add column price_level_id bigint references price_levels(id),
  add column parent_contact_id bigint references contacts(id),
  add constraint contacts_not_own_parent check (parent_contact_id is null or parent_contact_id <> id);
create index contacts_parent_idx on contacts (parent_contact_id) where parent_contact_id is not null;

-- Parent and sub-customers (RC8): both must be customers, no loops, and at
-- most 4 levels from the top customer down.
create function tohyee_check_customer_hierarchy() returns trigger
language plpgsql as $$
declare
  cursor_id bigint;
  parent_is_customer boolean;
  above integer := 0;
  below integer;
begin
  if new.parent_contact_id is not null then
    if not new.is_customer then
      raise exception 'Only a customer can have a parent customer' using errcode = 'P0001';
    end if;
    select is_customer into parent_is_customer from contacts where id = new.parent_contact_id;
    if not coalesce(parent_is_customer, false) then
      raise exception 'A parent customer must be a customer' using errcode = 'P0001';
    end if;
    cursor_id := new.parent_contact_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'A customer can''t be under one of its own sub-customers' using errcode = 'P0001';
      end if;
      above := above + 1;
      exit when above > 10;
      select parent_contact_id into cursor_id from contacts where id = cursor_id;
    end loop;
    with recursive sub(id, depth) as (
      select id, 1 from contacts where parent_contact_id = new.id
      union all
      select c.id, s.depth + 1 from contacts c join sub s on c.parent_contact_id = s.id where s.depth < 10
    )
    select coalesce(max(depth), 0) into below from sub;
    if above + 1 + below > 4 then
      raise exception 'A customer hierarchy can be at most 4 levels deep' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.is_customer and not new.is_customer
     and exists (select 1 from contacts where parent_contact_id = new.id) then
    raise exception 'A customer with sub-customers must stay a customer' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger contacts_customer_hierarchy before insert or update of parent_contact_id, is_customer on contacts
  for each row execute function tohyee_check_customer_hierarchy();

-- Credit limits (RC3-RC5): warn (approve and say so) or block.
alter table organisation_settings
  add column credit_limit_action text not null default 'warn' check (credit_limit_action in ('warn', 'block'));

-- Contact people are the CRM's people (RC6); one per company can be the
-- primary contact for invoices.
alter table crm_people add column is_primary boolean not null default false;
alter table crm_people add constraint crm_people_primary_check check (not is_primary or (contact_id is not null and not is_archived));
create unique index crm_people_primary_idx on crm_people (contact_id) where is_primary;
`,
  };
