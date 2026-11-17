import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0064",
    name: "payroll_payday_filing_settings",
    sql: `
-- Payroll stage P6 (examples PF1-PF9, decision 62): the header details of
-- IRD's payday filing employment information file. Making a file stores
-- nothing else (decision 65). Version 0063 is taken by another branch.
alter table organisation_settings
  add column payroll_employer_ird_number text
    check (payroll_employer_ird_number ~ '^[0-9]{9}$' and payroll_employer_ird_number <> '000000000'),
  add column payroll_contact_name text
    check (char_length(payroll_contact_name) between 1 and 20 and position(',' in payroll_contact_name) = 0),
  add column payroll_contact_phone text check (payroll_contact_phone ~ '^[0-9A-Za-z]{1,12}$'),
  add column payroll_contact_email text
    check (char_length(payroll_contact_email) <= 60 and payroll_contact_email ~ '^[A-Za-z0-9@_.-]+$');
`,
  };
