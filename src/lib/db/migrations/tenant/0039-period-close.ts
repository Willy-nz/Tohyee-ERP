import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0039",
    name: "period_close",
    sql: `
-- Period close (examples PC1-PC12), like NetSuite's Period Close Checklist:
-- months are closed in order and the lock date is the last day closed, so
-- reopening a month reopens every later one. The unlock window goes: an
-- open window becomes a reopening from its first day (what reopening that
-- month does now), recorded in the audit log.
insert into audit_events (event_type, entity_type, entity_id, actor_email, details)
select 'ledger.period_reopened', 'accounting_period_controls', '1', null,
       jsonb_build_object(
         'reason', 'Tohyee update: the unlock window from ' || unlock_start || ' to ' || unlock_end
                   || ' became a reopening from ' || unlock_start || ' (unlock windows were replaced by Period close).',
         'from', jsonb_build_object('lockDate', lock_date::text),
         'to', jsonb_build_object('lockDate', (unlock_start - 1)::text))
  from accounting_period_controls
 where unlock_start is not null and lock_date is not null and unlock_start <= lock_date;
update accounting_period_controls
   set lock_date = unlock_start - 1, updated_at = now()
 where unlock_start is not null and lock_date is not null and unlock_start <= lock_date;
alter table accounting_period_controls drop column unlock_start, drop column unlock_end;

-- Nothing can be posted on or before the lock date, whatever the app does.
-- The row is read "for share" so closing a period waits for postings in
-- progress, and postings wait for a close in progress.
create function tohyee_refuse_locked_posting() returns trigger
language plpgsql as $$
declare
  locked date;
begin
  select lock_date into locked from accounting_period_controls where id for share;
  if locked is not null and new.posting_date <= locked then
    raise exception 'Journal dated % is in a closed period (closed up to %).', new.posting_date, locked
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger ledger_journals_open_period
  before insert on ledger_journals
  for each row execute function tohyee_refuse_locked_posting();
`,
  };
