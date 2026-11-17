import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0205",
    name: "tractor_job_versions",
    sql: `
-- Every version of a tractor job's details (#491, decisions 1100-1104):
-- paddocks and the boundary versions the estimate was clipped to, the
-- estimate's summary, notes, the entered product, rate and quantity, links,
-- times marked "not working" and whether it's withdrawn, with who, when
-- (the database's time) and why. Never changed or deleted. The track
-- itself stays in tractor_jobs, unchanged.
create table tractor_job_versions (
  id bigserial primary key,
  job_id uuid not null references tractor_jobs(id),
  version integer not null check (version >= 1),
  change text not null check (change in ('saved', 'changed', 'corrected', 'withdrawn', 'before_history')),
  details jsonb not null check (jsonb_typeof(details) = 'object'),
  reason text check (reason is null or length(reason) between 1 and 1000),
  entered_by_user_id uuid,
  entered_by_email text not null,
  entered_at timestamptz not null default now(),
  unique (job_id, version)
);

-- Times the person says Working was really OFF (forgot to switch it):
-- the estimate leaves them out; the track keeps Working as it was switched.
alter table tractor_jobs add column not_working jsonb not null default '[]'::jsonb check (jsonb_typeof(not_working) = 'array');

-- Jobs from before this: one never changed is as it was saved, so its first
-- version is that. One already changed has lost what it said before, so its
-- first version says so ("before_history") and is dated now, not invented.
insert into tractor_job_versions (job_id, version, change, details, entered_by_user_id, entered_by_email, entered_at)
select j.id, 1,
       case when j.updated_at is null then 'saved' else 'before_history' end,
       jsonb_build_object(
         'paddockIds', to_jsonb(j.paddock_ids::text[]),
         'boundaryIds', to_jsonb(j.boundary_ids::text[]),
         'summary', j.summary,
         'notes', j.notes,
         'product', j.product,
         'declaredRate', j.declared_rate::text,
         'declaredRateUnit', j.declared_rate_unit,
         'declaredQuantity', j.declared_quantity::text,
         'declaredQuantityUnit', j.declared_quantity_unit,
         'fertiliserPlanId', j.fertiliser_plan_id::text,
         'fertiliserApplicationId', j.fertiliser_application_id::text,
         'chemicalRecordId', j.chemical_record_id::text,
         'notWorking', '[]'::jsonb,
         'status', j.status,
         'withdrawnReason', j.withdrawn_reason
       ),
       case when j.updated_at is null then j.operator_user_id else null end,
       case when j.updated_at is null then j.operator_email else 'Tohyee (when version history started)' end,
       case when j.updated_at is null then j.received_at else now() end
  from tractor_jobs j
 where not exists (select 1 from tractor_job_versions v where v.job_id = j.id);

-- From here the time is always the database's.
create function tohyee_tractor_version_time() returns trigger
language plpgsql as $$
begin
  new.entered_at := now();
  return new;
end;
$$;
create trigger tractor_job_versions_time before insert on tractor_job_versions for each row execute function tohyee_tractor_version_time();
create trigger tractor_job_versions_append_only before update or delete on tractor_job_versions
  for each row execute function toeyee_forbid_mutation();
create trigger tractor_job_versions_no_truncate before truncate on tractor_job_versions
  for each statement execute function toeyee_forbid_mutation();
`,
  };
