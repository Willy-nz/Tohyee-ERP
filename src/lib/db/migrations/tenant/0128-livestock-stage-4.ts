import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0128",
    name: "livestock_stage_4",
    sql: `
-- Livestock stage 4 (examples LV21-LV26 approved by Jess 12 Oct 2026,
-- decision 508, from IRD OS 25/02): deer and goats, herd value ratios,
-- male breeding stock in the herd scheme alongside NSC, and high-priced
-- livestock. IRD's 2026 deer and goat rates were read twice on 11-12 Oct 2026.
insert into livestock_rates (income_year, rate_kind, kind, category, amount, source, entered_by_email)
select 2026, r.rate_kind, r.kind, r.category, r.amount, r.source, 'tohyee' from (values
    ('namv', 'deer_red', 'r1_hinds', 295.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_red', 'r2_hinds', 525.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_red', 'ma_hinds', 612.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_red', 'r1_stags', 383.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_red', 'r2_stags', 691.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_red', 'breeding_stags', 3370.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'r1_hinds', 241.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'r2_hinds', 387.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'ma_hinds', 450.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'r1_stags', 329.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'r2_stags', 635.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'deer_other', 'breeding_stags', 2235.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_angora', 'r1_does', 136.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_angora', 'ma_does', 173.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_angora', 'r1_bucks_wethers', 89.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_angora', 'bucks_wethers', 95.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_angora', 'breeding_bucks', 512.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_cashmere', 'r1_does', 105.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_cashmere', 'ma_does', 155.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_cashmere', 'r1_bucks_wethers', 84.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_cashmere', 'bucks_wethers', 101.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_cashmere', 'breeding_bucks', 442.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_dairy', 'r1_does', 164.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_dairy', 'does', 254.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_dairy', 'breeding_bucks', 418.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('namv', 'goats_dairy', 'culls', 76.00, 'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026'),
    ('nsc', 'deer', 'rising_1', 108.80, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'),
    ('nsc', 'deer', 'rising_2', 54.70, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'),
    ('nsc', 'goats_meat_fibre', 'rising_1', 34.20, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'),
    ('nsc', 'goats_meat_fibre', 'rising_2', 23.90, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'),
    ('nsc', 'goats_dairy', 'rising_1', 263.60, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026'),
    ('nsc', 'goats_dairy', 'rising_2', 53.60, 'IRD: National Standard Costs for Specified Livestock Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/standard-costs/nsc-2026')
  ) as r(rate_kind, kind, category, amount, source)
on conflict (income_year, rate_kind, kind, category) do nothing;

-- A herd value ratio applies to the whole kind (OS 25/02 paras 45-52); 0.3 is the Chatham Islands adjustment.
alter table livestock_elections
  add column herd_value_ratio numeric(2, 1) check (herd_value_ratio in (0.3, 0.9, 1.0, 1.1, 1.2, 1.3)),
  add column male_breeding_herd_scheme boolean not null default false,
  add check (herd_value_ratio is null or method = 'herd_scheme'),
  add check (not male_breeding_herd_scheme or method = 'nsc');

-- High-priced livestock (OS 25/02 paras 68-71): at cost in the year bought, then less IRD's
-- depreciation rate (typed with its source) each year, until at or below its class's NAMV.
create table livestock_high_priced (
  id bigserial primary key,
  kind text not null,
  class_code text not null,
  description text not null check (length(description) between 1 and 200),
  bought_on date not null,
  cost numeric(12, 2) not null check (cost >= 500),
  rate_percent numeric(5, 2) not null check (rate_percent > 0 and rate_percent <= 100),
  rate_source text not null check (length(rate_source) between 1 and 500),
  prior_year_namv numeric(12, 2) check (prior_year_namv is null or prior_year_namv >= 0),
  left_on date,
  -- Sold or died (a movement takes it out of its class), or stopped breeding (it reverts to its class).
  left_how text check (left_how in ('sold_or_died', 'stopped_breeding')),
  left_reason text,
  created_by_email text not null,
  check ((left_on is null) = (left_how is null)),
  created_at timestamptz not null default now()
);
`,
  };
