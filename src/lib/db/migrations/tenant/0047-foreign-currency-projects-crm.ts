import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0047",
    name: "foreign_currency_projects_crm",
    sql: `
-- Projects and CRM opportunities in a customer's currency (MC61-MC70),
-- following NetSuite: "Projects and their associated transactions must share
-- a single currency", and a new transaction starts in the customer's
-- currency. A project's rates, fixed prices and estimate are in its currency,
-- and so are an opportunity's amount. Existing ones take their customer's
-- currency (the base currency for customers without one).
alter table projects disable trigger projects_guard;
alter table projects add column currency_code text;
update projects p
   set currency_code = coalesce(c.currency_code, (select base_currency from organisation_settings limit 1), 'NZD')
  from contacts c where c.id = p.contact_id;
alter table projects enable trigger projects_guard;
alter table projects alter column currency_code set not null;
alter table projects add constraint projects_currency_code_check check (currency_code ~ '^[A-Z]{3}$');

alter table crm_opportunities add column currency_code text;
update crm_opportunities o
   set currency_code = coalesce(c.currency_code, (select base_currency from organisation_settings limit 1), 'NZD')
  from contacts c where c.id = o.contact_id;
alter table crm_opportunities alter column currency_code set not null;
alter table crm_opportunities add constraint crm_opportunities_currency_code_check check (currency_code ~ '^[A-Z]{3}$');

-- They're in their contact's currency (the same check as quotes, 0043).
create trigger projects_currency_check before insert or update of contact_id, currency_code on projects
  for each row execute function tohyee_check_contact_currency();
create trigger crm_opportunities_currency_check before insert or update of contact_id, currency_code on crm_opportunities
  for each row execute function tohyee_check_contact_currency();

-- A project's currency doesn't change once it has tasks, time, expenses or
-- invoices (their amounts are in it); an opportunity's once it has made its
-- invoice.
create function tohyee_guard_project_currency() returns trigger
language plpgsql as $$
begin
  if new.currency_code <> old.currency_code
     and (exists (select 1 from project_tasks where project_id = old.id)
          or exists (select 1 from project_time_entries where project_id = old.id)
          or exists (select 1 from project_expenses where project_id = old.id)
          or exists (select 1 from project_invoices where project_id = old.id)) then
    raise exception 'Project % has tasks, time, expenses or invoices in %, so its currency can''t change', old.name, old.currency_code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger projects_currency_guard before update of currency_code on projects
  for each row execute function tohyee_guard_project_currency();

create function tohyee_guard_opportunity_currency() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.currency_code <> old.currency_code or new.contact_id <> old.contact_id) then
    raise exception 'Opportunity % has made an invoice, so its company and currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_currency_guard before update of contact_id, currency_code on crm_opportunities
  for each row execute function tohyee_guard_opportunity_currency();

-- A contact's currency can't change once it has projects or opportunities
-- either (their estimates, rates and amounts are in it). A trigger of its
-- own, beside contacts_currency_guard.
create function tohyee_guard_contact_currency_projects() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from projects where contact_id = old.id)
          or exists (select 1 from crm_opportunities where contact_id = old.id)) then
    raise exception 'Contact % has projects or opportunities, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_projects_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency_projects();

-- Charging an expense on a project in another currency isn't settled (its
-- cost is in the base currency, and which rate converts it isn't), so a
-- foreign-currency project's expenses are costs only (MC63).
create function tohyee_check_project_expense_currency() returns trigger
language plpgsql as $$
begin
  if new.chargeable and new.status = 'active'
     and (select p.currency_code from projects p where p.id = new.project_id)
         <> (select base_currency from organisation_settings limit 1) then
    raise exception 'Expenses on a project in another currency can''t be chargeable yet' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger project_expenses_currency_check before insert or update of chargeable, status on project_expenses
  for each row execute function tohyee_check_project_expense_currency();
`,
  };
