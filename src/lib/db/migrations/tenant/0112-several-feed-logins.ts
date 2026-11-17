import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0112",
    name: "several_feed_logins",
    sql: `
-- Several logins per bank feed provider (#182, examples BK30-BK37, decision
-- 481; replaces decision 388's "one connection per provider"). Each login
-- has a name, unique among the provider's active logins. The existing
-- connection becomes a login named after the provider (BK37).
alter table akahu_connections
  add column name text,
  -- Why the login's tokens stopped working (BK33), until new ones are saved (BK34).
  add column token_problem text check (token_problem is null or length(token_problem) between 1 and 500);
update akahu_connections set name = 'Akahu';
alter table akahu_connections alter column name set not null,
  add constraint akahu_connections_name check (length(name) between 1 and 100);
drop index akahu_connections_one_active;
create unique index akahu_connections_name_once on akahu_connections (lower(name)) where status = 'active';

-- Which login an Akahu feed syncs with (BK31, BK32); existing feeds use the existing connection.
alter table bank_account_settings add column akahu_connection_id bigint references akahu_connections(id);
update bank_account_settings
   set akahu_connection_id = (select id from akahu_connections order by (status = 'active') desc, id desc limit 1)
 where akahu_account_id is not null;

alter table simplefin_connections add column name text;
update simplefin_connections set name = 'SimpleFIN';
alter table simplefin_connections alter column name set not null,
  add constraint simplefin_connections_name check (length(name) between 1 and 100);
drop index simplefin_connections_one_active;
create unique index simplefin_connections_name_once on simplefin_connections (lower(name)) where status = 'active';

alter table stripe_connections add column name text;
update stripe_connections set name = 'Stripe';
alter table stripe_connections alter column name set not null,
  add constraint stripe_connections_name check (length(name) between 1 and 100);
drop index stripe_connections_one_active;
create unique index stripe_connections_name_once on stripe_connections (lower(name)) where status = 'active';

alter table paypal_connections add column name text;
update paypal_connections set name = 'PayPal';
alter table paypal_connections alter column name set not null,
  add constraint paypal_connections_name check (length(name) between 1 and 100);
drop index paypal_connections_one_active;
create unique index paypal_connections_name_once on paypal_connections (lower(name)) where status = 'active';

alter table wise_connections add column name text;
update wise_connections set name = 'Wise';
alter table wise_connections alter column name set not null,
  add constraint wise_connections_name check (length(name) between 1 and 100);
drop index wise_connections_one_active;
create unique index wise_connections_name_once on wise_connections (lower(name)) where status = 'active';

-- Stripe, PayPal and Wise: one link per currency per login, not per organisation.
drop index stripe_links_currency_once;
create unique index stripe_links_currency_once on stripe_links (connection_id, currency_code) where active;
drop index paypal_links_currency_once;
create unique index paypal_links_currency_once on paypal_links (connection_id, currency_code) where active;
drop index wise_links_currency_once;
create unique index wise_links_currency_once on wise_links (connection_id, currency_code) where active;
`,
  };
