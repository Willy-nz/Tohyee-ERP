import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0031",
    name: "standard_tax_codes",
    sql: `
-- New organisations now start with the standard NZ GST codes (like Xero), so
-- invoices and bills can be raised straight away. Existing organisations get
-- the same four here, but only if they have no tax codes at all: one that
-- already has any is left alone, so nothing is duplicated or clashes with
-- codes people made themselves. They apply from 1 October 2010, when GST
-- became 15%. (A brand-new database has no organisation_settings row yet;
-- provisioning seeds its codes after the migrations.)
insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from)
select 'system', c.idempotency_key, 'nz-default-tax-code', c.code, c.label, c.category, c.rate, date '2010-10-01'
  from (values ('nz-default-tax-code-gst', 'GST', 'GST (15%)', 'standard', 0.15::numeric, 1),
               ('nz-default-tax-code-zero', 'ZERO', 'Zero rated', 'zero_rated', 0::numeric, 2),
               ('nz-default-tax-code-exempt', 'EXEMPT', 'Exempt', 'exempt', 0::numeric, 3),
               ('nz-default-tax-code-none', 'NONE', 'No GST', 'out_of_scope', 0::numeric, 4))
       as c (idempotency_key, code, label, category, rate, position)
 where exists (select 1 from organisation_settings)
   and not exists (select 1 from tax_codes)
 order by c.position;
`,
  };
