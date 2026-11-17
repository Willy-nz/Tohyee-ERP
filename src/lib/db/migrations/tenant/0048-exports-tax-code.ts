import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0048",
    name: "exports_tax_code",
    sql: `
-- Exports and the tax code for overseas customers (EX1-EX15), following
-- NetSuite: a "Foreign Trade" box and a "Tax Code for Exports" per
-- organisation, and a customer's own tax code. Contacts get a country for
-- their billing address and (optionally) their delivery address, as ISO
-- 3166-1 alpha-2 codes; the addresses themselves stay free text. Existing
-- contacts are in New Zealand, and existing organisations have Foreign trade
-- off with ZERO as the tax code for exports (EX1).
alter table contacts add column billing_country text not null default 'NZ'
  check (billing_country ~ '^[A-Z]{2}$');
alter table contacts add column delivery_country text
  check (delivery_country ~ '^[A-Z]{2}$');
alter table contacts add column default_sales_tax_code_id bigint references tax_codes(id);

alter table organisation_settings add column foreign_trade boolean not null default false;
alter table organisation_settings add column export_tax_code_id bigint references tax_codes(id);
update organisation_settings
   set export_tax_code_id = (select id from tax_codes where code = 'ZERO' and category = 'zero_rated');

-- The tax code for exports is zero-rated (IR375: exports are zero-rated, not
-- exempt), so the sale is in Box 5 and Box 6 (EX11, EX13).
create function tohyee_check_export_tax_code() returns trigger
language plpgsql as $$
begin
  if new.export_tax_code_id is not null
     and (select category from tax_codes where id = new.export_tax_code_id) <> 'zero_rated' then
    raise exception 'The tax code for exports must be zero-rated' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_export_tax_code_check
  before insert or update of export_tax_code_id on organisation_settings
  for each row execute function tohyee_check_export_tax_code();
`,
  };
