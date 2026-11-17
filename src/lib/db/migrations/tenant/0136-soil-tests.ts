import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0136",
    name: "soil_tests",
    sql: `
-- Soil tests (#249): one sample on a paddock, its results as the lab reported
-- them (the text kept beside the number, so "<0.5" isn't lost), and no unit
-- conversions. The lab's report is attached as a file (record type soil_test).
create table soil_tests (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  sampled_on date not null,
  sample_name text check (sample_name is null or length(sample_name) between 1 and 100),
  lab text check (lab is null or length(lab) between 1 and 100),
  lab_reference text check (lab_reference is null or length(lab_reference) between 1 and 100),
  depth text check (depth is null or length(depth) between 1 and 40),
  source text not null check (length(source) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index soil_tests_paddock on soil_tests (paddock_id, sampled_on) where status = 'active';

create table soil_test_results (
  id bigserial primary key,
  soil_test_id bigint not null references soil_tests(id),
  line_order integer not null,
  measure text not null check (length(measure) between 1 and 100),
  value numeric check (value is null or (scale(value) <= 4 and abs(value) < 1e14)),
  value_text text not null check (length(value_text) between 1 and 50),
  unit text check (unit is null or length(unit) between 1 and 40),
  unique (soil_test_id, measure)
);

create trigger soil_test_results_no_delete before delete or update on soil_test_results for each row execute function toeyee_forbid_delete();

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications', 'soil_tests'));

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit', 'soil_test'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit', 'soil_test'));
`,
  };
