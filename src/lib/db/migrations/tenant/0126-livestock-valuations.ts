import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0126",
    name: "livestock_valuations",
    sql: `
-- Livestock year-end valuation (#221 stage 3; examples LV4-LV12 approved by
-- Jess 11 Oct 2026, decisions 503 and 505). IRD's rates by income year,
-- each farm's elections with evidence, and approved valuations with their
-- journals. Nothing is filed with IRD.
alter table livestock_settings
  add column revaluation_target text not null default 'profit_and_loss' check (revaluation_target in ('profit_and_loss', 'reserve')),
  add column asset_account_id bigint references accounts(id),
  add column value_change_account_id bigint references accounts(id),
  add column revaluation_account_id bigint references accounts(id),
  add column reserve_account_id bigint references accounts(id);

-- National average market values (NAMV) and national standard costs (NSC)
-- by income year (2026 = the 2025-26 income year), with where they came from.
create table livestock_rates (
  id bigserial primary key,
  income_year integer not null check (income_year between 2000 and 2100),
  rate_kind text not null check (rate_kind in ('namv', 'nsc')),
  kind text not null,
  -- NAMV: a class code. NSC: rising_1, rising_2 or purchased_bobby_calves.
  category text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  source text not null check (length(source) between 1 and 500),
  entered_by_email text not null,
  entered_at timestamptz not null default now(),
  unique (income_year, rate_kind, kind, category)
);

-- IRD's 2026 determinations (NAMV made 26 May 2026; NSC signed 23 Feb 2026),
-- read from IRD's site and checked twice on 11 Oct 2026.
insert into livestock_rates (income_year, rate_kind, kind, category, amount, source, entered_by_email)
select 2026, r.rate_kind, r.kind, r.category, r.amount::numeric, s.source, 'tohyee'
  from (values
    ('namv', 'sheep', 'ewe_hoggets', '188.00'), ('namv', 'sheep', 'ram_wether_hoggets', '180.00'),
    ('namv', 'sheep', 'two_tooth_ewes', '265.00'), ('namv', 'sheep', 'ma_ewes', '237.00'),
    ('namv', 'sheep', 'r5_ewes', '205.00'), ('namv', 'sheep', 'ma_wethers', '176.00'), ('namv', 'sheep', 'breeding_rams', '431.00'),
    ('namv', 'beef_cattle', 'r1_heifers', '1319.00'), ('namv', 'beef_cattle', 'r2_heifers', '1959.00'),
    ('namv', 'beef_cattle', 'ma_cows', '2376.00'), ('namv', 'beef_cattle', 'r1_steers_bulls', '1619.00'),
    ('namv', 'beef_cattle', 'r2_steers_bulls', '2273.00'), ('namv', 'beef_cattle', 'r3_steers_bulls', '2807.00'),
    ('namv', 'beef_cattle', 'breeding_bulls', '5008.00'),
    ('namv', 'dairy_cattle', 'r1_heifers', '1326.00'), ('namv', 'dairy_cattle', 'r2_heifers', '2598.00'),
    ('namv', 'dairy_cattle', 'ma_cows', '2824.00'), ('namv', 'dairy_cattle', 'r1_steers_bulls', '1214.00'),
    ('namv', 'dairy_cattle', 'r2_steers_bulls', '2070.00'), ('namv', 'dairy_cattle', 'r3_steers_bulls', '2591.00'),
    ('namv', 'dairy_cattle', 'breeding_bulls', '3035.00'),
    ('nsc', 'sheep', 'rising_1', '41.40'), ('nsc', 'sheep', 'rising_2', '29.80'),
    ('nsc', 'dairy_cattle', 'purchased_bobby_calves', '282.50'), ('nsc', 'dairy_cattle', 'rising_1', '788.90'),
    ('nsc', 'dairy_cattle', 'rising_2', '535.50'),
    ('nsc', 'beef_cattle', 'rising_1', '443.40'), ('nsc', 'beef_cattle', 'rising_2', '251.00')
  ) as r(rate_kind, kind, category, amount)
  cross join lateral (select case r.rate_kind
    when 'namv' then 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'
    else 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'
  end as source) s;

-- Each farm's valuation method by kind of livestock, from an income year,
-- with the evidence attached as files. Recording one files nothing with IRD.
create table livestock_elections (
  id bigserial primary key,
  kind text not null,
  method text not null check (method in ('herd_scheme', 'nsc')),
  from_income_year integer not null check (from_income_year between 2000 and 2100),
  note text check (note is null or length(note) <= 1000),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (kind, from_income_year)
);

create table livestock_valuations (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  year_end date not null,
  income_year integer not null,
  status text not null default 'approved' check (status in ('approved', 'replaced')),
  revaluation_target text not null check (revaluation_target in ('profit_and_loss', 'reserve')),
  -- The workings, by kind and class, as approved (rates, heads, values).
  workings jsonb not null,
  opening_value numeric(18, 2) not null,
  revaluation numeric(18, 2) not null,
  closing_value numeric(18, 2) not null,
  value_change numeric(18, 2) not null,
  sales numeric(18, 2) not null,
  purchases numeric(18, 2) not null,
  taxable_profit numeric(18, 2) not null,
  journal_id bigint references ledger_journals(id),
  approved_by_user_id uuid,
  approved_by_email text not null,
  approved_at timestamptz not null default now(),
  replace_reason text,
  reversal_journal_id bigint references ledger_journals(id),
  replaced_by_email text,
  replaced_at timestamptz,
  unique (command_source, idempotency_key)
);
create unique index livestock_valuations_year on livestock_valuations (year_end) where status = 'approved';

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election'));

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation'));
`,
  };
