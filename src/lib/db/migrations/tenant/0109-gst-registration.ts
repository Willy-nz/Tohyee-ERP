import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0109",
    name: "gst_registration",
    sql: `
-- GST registration (issue #180, NR1-NR8). gst_registered says whether the
-- organisation is registered for GST at all; gst_registered_from and
-- gst_registered_until (both optional, inclusive) limit when. Null "from"
-- means registered from the start. New organisations start registered, as
-- before. An existing organisation with no GST number that has never had
-- GST in its books (nothing on the GST account) isn't registered (NR8).
alter table organisation_settings
  add column gst_registered boolean not null default true,
  add column gst_registered_from date,
  add column gst_registered_until date,
  add constraint organisation_settings_gst_registration
    check ((gst_registered or (gst_registered_from is null and gst_registered_until is null))
           and (gst_registered_until is null or gst_registered_from is null or gst_registered_until >= gst_registered_from));

update organisation_settings
   set gst_registered = false
 where gst_number is null
   and exists (select 1 from ledger_journals)
   and not exists (select 1 from ledger_journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'gst');
`,
  };
