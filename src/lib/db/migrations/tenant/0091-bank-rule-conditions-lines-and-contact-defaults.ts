import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0091",
    name: "bank_rule_conditions_lines_and_contact_defaults",
    sql: `
-- Bank rules with several conditions and split lines (BR1-BR10, decisions
-- 380-383). Each existing rule becomes one text condition and one 100% line,
-- so it suggests exactly what it did before (BR10).
alter table bank_rules add column match_mode text not null default 'all' check (match_mode in ('all', 'any'));
alter table bank_rules add column contact_mode text not null default 'chosen' check (contact_mode in ('chosen', 'payee'));
alter table bank_rules alter column contact_id drop not null;
alter table bank_rules add constraint bank_rules_contact_chosen_check
  check ((contact_mode = 'chosen') = (contact_id is not null));

create table bank_rule_conditions (
  id bigserial primary key,
  rule_id bigint not null references bank_rules(id) on delete cascade,
  position integer not null check (position between 1 and 10),
  field text not null check (field in ('any', 'description', 'payee', 'particulars', 'code', 'reference', 'amount')),
  operator text not null check (operator in ('contains', 'equals', 'starts_with', 'at_least', 'at_most', 'between')),
  text_value text,
  amount_from numeric(18, 2),
  amount_to numeric(18, 2),
  unique (rule_id, position),
  check (
    case when field = 'amount' then
      operator in ('equals', 'at_least', 'at_most', 'between')
      and text_value is null and amount_from is not null and amount_from >= 0
      and (operator = 'between') = (amount_to is not null)
      and (amount_to is null or amount_to >= amount_from)
    else
      operator in ('contains', 'equals', 'starts_with')
      and text_value is not null and length(text_value) between 1 and 200
      and amount_from is null and amount_to is null
    end
  )
);

create table bank_rule_lines (
  id bigserial primary key,
  rule_id bigint not null references bank_rules(id) on delete cascade,
  position integer not null check (position between 1 and 20),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  description text check (description is null or length(description) between 1 and 500),
  tracking jsonb not null default '{}'::jsonb check (jsonb_typeof(tracking) = 'object'),
  fixed_amount numeric(18, 2) check (fixed_amount is null or fixed_amount > 0),
  percentage numeric(5, 2) check (percentage is null or (percentage > 0 and percentage <= 100)),
  unique (rule_id, position),
  check ((fixed_amount is null) <> (percentage is null))
);
create index bank_rule_lines_tax_code_idx on bank_rule_lines (tax_code_id);

insert into bank_rule_conditions (rule_id, position, field, operator, text_value)
select id, 1, match_field, 'contains', match_text from bank_rules;
insert into bank_rule_lines (rule_id, position, account_id, tax_code_id, description, percentage)
select id, 1, target_account_id, tax_code_id, line_description, 100 from bank_rules;

drop trigger bank_rules_tax_code_check on bank_rules;
drop function tohyee_check_bank_rule_tax_code();
-- The statement line's amount includes GST, so a rule's lines are GST inclusive
-- when they have a GST code and have no tax otherwise (decision 381).
alter table bank_rules drop column match_field, drop column match_text, drop column target_account_id,
  drop column tax_code_id, drop column line_description, drop column amounts_mode;

-- A rule's line codes money in as receive money (sales), money out as spend
-- money (purchases), either as both (TAO8). Checked when a line is saved and
-- when the rule's direction changes.
create function tohyee_bank_rule_line_tax_ok(code_id bigint, direction text) returns boolean
language sql stable as $$
  select (direction not in ('in', 'any') or tohyee_tax_code_available(code_id, 'sales'))
     and (direction not in ('out', 'any') or tohyee_tax_code_available(code_id, 'purchases'))
$$;
create function tohyee_check_bank_rule_line_tax_code() returns trigger
language plpgsql as $$
begin
  if not tohyee_bank_rule_line_tax_ok(new.tax_code_id, (select direction from bank_rules where id = new.rule_id)) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rule_lines_tax_code_check
  before insert or update of tax_code_id, rule_id on bank_rule_lines
  for each row execute function tohyee_check_bank_rule_line_tax_code();
create function tohyee_check_bank_rule_direction() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from bank_rule_lines l where l.rule_id = new.id and not tohyee_bank_rule_line_tax_ok(l.tax_code_id, new.direction)) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rules_direction_check
  before update of direction on bank_rules
  for each row execute function tohyee_check_bank_rule_direction();

-- Contacts' default accounts and tracking (SD1-SD3, decision 384).
alter table contacts add column default_purchase_account_id bigint references accounts(id);
alter table contacts add column default_sales_account_id bigint references accounts(id);
alter table contacts add column default_purchase_tracking jsonb not null default '{}'::jsonb
  check (jsonb_typeof(default_purchase_tracking) = 'object');
alter table contacts add column default_sales_tracking jsonb not null default '{}'::jsonb
  check (jsonb_typeof(default_sales_tracking) = 'object');

-- The "Available on" backstop (TAO10), now looking at rule lines.
create or replace function tohyee_guard_tax_code_available_on() returns trigger
language plpgsql as $$
begin
  if new.available_on = old.available_on or new.available_on = 'both' then
    return new;
  end if;
  if new.available_on = 'purchases' and (
       exists (select 1 from contacts where default_sales_tax_code_id = old.id)
       or exists (select 1 from organisation_settings where export_tax_code_id = old.id)
       or exists (select 1 from items where sales_tax_code_id = old.id)
       or exists (select 1 from bank_rule_lines l join bank_rules r on r.id = l.rule_id
                   where l.tax_code_id = old.id and r.direction in ('in', 'any'))) then
    raise exception 'Tax code % is used for sales, so it can''t be made available on purchases only', old.code
      using errcode = '23514';
  end if;
  if new.available_on = 'sales' and (
       exists (select 1 from contacts where default_purchase_tax_code_id = old.id)
       or exists (select 1 from items where purchase_tax_code_id = old.id)
       or exists (select 1 from bank_rule_lines l join bank_rules r on r.id = l.rule_id
                   where l.tax_code_id = old.id and r.direction in ('out', 'any'))) then
    raise exception 'Tax code % is used for purchases, so it can''t be made available on sales only', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
`,
  };
