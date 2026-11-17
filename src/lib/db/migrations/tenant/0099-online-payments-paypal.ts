import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0099",
    name: "online_payments_paypal",
    sql: `
-- Pay with PayPal (PPN1-PPN10, decisions 420-423): the online payment tables
-- also hold PayPal, whose "links" are invoices in the organisation's own
-- PayPal account. An invoice can have one open link per provider.
alter table online_payment_settings drop constraint online_payment_settings_provider_check;
alter table online_payment_settings add constraint online_payment_settings_provider_check check (provider in ('stripe', 'paypal'));
alter table invoice_payment_links drop constraint invoice_payment_links_provider_check;
alter table invoice_payment_links add constraint invoice_payment_links_provider_check check (provider in ('stripe', 'paypal'));
drop index invoice_payment_links_one_open;
create unique index invoice_payment_links_one_open on invoice_payment_links (invoice_id, provider) where status = 'open';
alter table online_payments drop constraint online_payments_provider_check;
alter table online_payments add constraint online_payments_provider_check check (provider in ('stripe', 'paypal'));
`,
  };
