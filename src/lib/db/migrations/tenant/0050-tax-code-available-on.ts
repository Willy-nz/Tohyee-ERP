import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0050",
    name: "tax_code_available_on",
    sql: `
-- A tax code's "Available on" (TAO1-TAO12), following NetSuite: Sales,
-- Purchases or Both. Every existing code is Both, so nothing changes for
-- existing organisations (TAO1). Document lines are checked when they're
-- saved or approved (like a code being active); saved documents are never
-- checked again. Here the database keeps the settings that choose a code
-- for one side on codes available on that side.
alter table tax_codes add column available_on text not null default 'both'
  check (available_on in ('sales', 'purchases', 'both'));

create function tohyee_tax_code_available(code_id bigint, side text) returns boolean
language sql stable as $$
  select code_id is null or exists (select 1 from tax_codes where id = code_id and available_on in (side, 'both'))
$$;

-- The tax code for exports is zero-rated (EX13) and available on sales (TAO7).
create or replace function tohyee_check_export_tax_code() returns trigger
language plpgsql as $$
begin
  if new.export_tax_code_id is not null
     and (select category from tax_codes where id = new.export_tax_code_id) <> 'zero_rated' then
    raise exception 'The tax code for exports must be zero-rated' using errcode = '23514';
  end if;
  if not tohyee_tax_code_available(new.export_tax_code_id, 'sales') then
    raise exception 'The tax code for exports must be available on sales' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- A contact's default sales tax code is available on sales, its default
-- purchase tax code on purchases (TAO7); only checked when it's set.
create function tohyee_check_contact_tax_defaults() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.default_sales_tax_code_id is distinct from old.default_sales_tax_code_id)
     and not tohyee_tax_code_available(new.default_sales_tax_code_id, 'sales') then
    raise exception 'A contact''s default sales tax code must be available on sales' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.default_purchase_tax_code_id is distinct from old.default_purchase_tax_code_id)
     and not tohyee_tax_code_available(new.default_purchase_tax_code_id, 'purchases') then
    raise exception 'A contact''s default purchase tax code must be available on purchases' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_tax_defaults_check
  before insert or update of default_sales_tax_code_id, default_purchase_tax_code_id on contacts
  for each row execute function tohyee_check_contact_tax_defaults();

-- An item's sales tax code likewise, and its purchase tax code (TAO7).
create function tohyee_check_item_tax_codes() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.sales_tax_code_id is distinct from old.sales_tax_code_id)
     and not tohyee_tax_code_available(new.sales_tax_code_id, 'sales') then
    raise exception 'An item''s sales tax code must be available on sales' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.purchase_tax_code_id is distinct from old.purchase_tax_code_id)
     and not tohyee_tax_code_available(new.purchase_tax_code_id, 'purchases') then
    raise exception 'An item''s purchase tax code must be available on purchases' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger items_tax_codes_check
  before insert or update of sales_tax_code_id, purchase_tax_code_id on items
  for each row execute function tohyee_check_item_tax_codes();

-- A bank rule for money in suggests receive money (sales), for money out
-- spend money (purchases), and for either both (TAO8).
create function tohyee_check_bank_rule_tax_code() returns trigger
language plpgsql as $$
begin
  if (new.direction in ('in', 'any') and not tohyee_tax_code_available(new.tax_code_id, 'sales'))
     or (new.direction in ('out', 'any') and not tohyee_tax_code_available(new.tax_code_id, 'purchases')) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rules_tax_code_check
  before insert or update of tax_code_id, direction on bank_rules
  for each row execute function tohyee_check_bank_rule_tax_code();

-- Changing a code's "Available on" is refused while a setting above uses it
-- on the side it would lose (TAO10). Tohyee lists them; this is the backstop.
create function tohyee_guard_tax_code_available_on() returns trigger
language plpgsql as $$
begin
  if new.available_on = old.available_on or new.available_on = 'both' then
    return new;
  end if;
  if new.available_on = 'purchases' and (
       exists (select 1 from contacts where default_sales_tax_code_id = old.id)
       or exists (select 1 from organisation_settings where export_tax_code_id = old.id)
       or exists (select 1 from items where sales_tax_code_id = old.id)
       or exists (select 1 from bank_rules where tax_code_id = old.id and direction in ('in', 'any'))) then
    raise exception 'Tax code % is used for sales, so it can''t be made available on purchases only', old.code
      using errcode = '23514';
  end if;
  if new.available_on = 'sales' and (
       exists (select 1 from contacts where default_purchase_tax_code_id = old.id)
       or exists (select 1 from items where purchase_tax_code_id = old.id)
       or exists (select 1 from bank_rules where tax_code_id = old.id and direction in ('out', 'any'))) then
    raise exception 'Tax code % is used for purchases, so it can''t be made available on sales only', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tax_codes_available_on_guard
  before update of available_on on tax_codes
  for each row execute function tohyee_guard_tax_code_available_on();
`,
  };
