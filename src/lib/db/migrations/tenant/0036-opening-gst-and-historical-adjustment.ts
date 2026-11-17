import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0036",
    name: "opening_gst_and_historical_adjustment",
    sql: `
-- Open invoices and bills at the conversion date carry the GST in what's
-- still owed (IM13, IM17-IM20), as in Xero: on the payments basis it's
-- returned when they're paid after the conversion. Their approval journal
-- still posts only Dr accounts receivable / Cr the conversion account (bills
-- the other way): the GST is already in the trial balance's GST line.
alter table sales_invoices drop constraint sales_invoices_opening_check;
alter table sales_invoices add constraint sales_invoices_opening_check
  check (not is_opening_balance or amounts_mode in ('no_tax', 'inclusive'));
alter table bills drop constraint bills_opening_check;
alter table bills add constraint bills_opening_check
  check (not is_opening_balance or amounts_mode in ('no_tax', 'inclusive'));

-- The account opening balances post through is equity, "Historical
-- adjustment" (IM1, IM21), like Xero's Historical Adjustment and NetSuite's
-- Opening Balance, at 3900 or the next free code up to 3999. An organisation
-- that already has the old 2990 Conversion clearing (current liability) with
-- nothing posted to it is changed over; one with postings is left as it is,
-- because an account's class is fixed once it has postings.
update accounts a
   set account_class = 'equity',
       account_type = 'equity',
       name = case when a.name = 'Conversion clearing' then 'Historical adjustment' else a.name end,
       code = case
                when a.code ~ '^299[0-9]$'
                  then coalesce((select min(c)::text from generate_series(3900, 3999) c
                                  where not exists (select 1 from accounts o where lower(o.code) = c::text)), a.code)
                else a.code
              end,
       description = 'Opening balances from invoices, bills and stock clear through here; it should always be 0.00.',
       updated_at = now()
 where a.system_key = 'conversion_clearing'
   and a.account_class <> 'equity'
   and not exists (select 1 from ledger_journal_lines l where l.account_id = a.id);
insert into accounts (code, name, account_class, account_type, system_key, description)
select (select min(c)::text from generate_series(3900, 3999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Historical adjustment', 'equity', 'equity', 'conversion_clearing',
       'Opening balances from invoices, bills and stock clear through here; it should always be 0.00.'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'conversion_clearing')
   and exists (select 1 from generate_series(3900, 3999) c where not exists (select 1 from accounts where lower(code) = c::text));
`,
  };
