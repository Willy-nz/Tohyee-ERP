import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0279",
    name: "livestock_pigs",
    sql: `
-- Pigs under the herd scheme (#243, decision 1604; LV30): IRD's 2026 NAMVs
-- for pigs, from the Income Tax (National Average Market Values of Specified
-- Livestock) Determination 2026, read from IRD's site on 13 Nov 2026.
insert into livestock_rates (income_year, rate_kind, kind, category, amount, source, entered_by_email)
select 2026, 'namv', 'pigs', r.category, r.amount::numeric,
       'IRD: Income Tax (National Average Market Values of Specified Livestock) Determination 2026, https://www.taxtechnical.ird.govt.nz/determinations/livestock/average-market-value/namv-2026',
       'tohyee'
  from (values
    ('sows_under_1', '314.00'), ('sows_over_1', '395.00'), ('breeding_boars', '423.00'),
    ('weaners', '149.00'), ('growing_10_17', '287.00'), ('growing_over_17', '369.00')
  ) as r(category, amount)
on conflict (income_year, rate_kind, kind, category) do nothing;
`,
  };
