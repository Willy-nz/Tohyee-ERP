import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0216",
    name: "gst_registration_confirmed",
    sql: `
-- GST registration a person has confirmed (#546, examples GSR1-GSR10,
-- decisions 1280-1287). gst_registered stays Tohyee's starting guess (NR8:
-- on, no dates) until someone confirms it; until then automatic posting
-- (sales platforms, AI bank coding) doesn't charge or claim GST on its own.
-- confirmed_by is the person's email, or what the confirmation came from.
alter table organisation_settings
  add column gst_registration_confirmed_at timestamptz,
  add column gst_registration_confirmed_by text
    check (gst_registration_confirmed_by is null or length(gst_registration_confirmed_by) between 1 and 320),
  add constraint organisation_settings_gst_registration_confirmed
    check ((gst_registration_confirmed_at is null) = (gst_registration_confirmed_by is null));

-- Already confirmed: a person changed the registration in Settings (the
-- audit trail records it), or the organisation is registered and has its
-- GST number in Settings (a number can only be typed by a person, and
-- registering needs one, NR5). Everything else, including NR8's guesses
-- either way, waits for a person. A GST basis alone confirms nothing, and a
-- missing number doesn't make an organisation not registered.
update organisation_settings s
   set gst_registration_confirmed_at = e.created_at,
       gst_registration_confirmed_by = coalesce(e.actor_email, 'Settings')
  from (select created_at, actor_email
          from audit_events
         where event_type = 'organisation.settings_updated'
           and (details ? 'gstRegistered' or details ? 'gstRegisteredFrom' or details ? 'gstRegisteredUntil')
         order by audit_events.id desc
         limit 1) e
 where s.id = true;

update organisation_settings
   set gst_registration_confirmed_at = now(),
       gst_registration_confirmed_by = 'GST number in Settings'
 where gst_registration_confirmed_at is null
   and gst_registered
   and gst_number is not null;
`,
  };
