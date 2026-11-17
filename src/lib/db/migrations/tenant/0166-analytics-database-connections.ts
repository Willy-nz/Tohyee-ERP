import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0166",
    name: "analytics_database_connections",
    sql: `
-- External databases as Analytics sources (decisions 602-605): a saved
-- connection to a SQL Server, PostgreSQL or MySQL database. The password is
-- encrypted with the server's key (src/lib/secrets) and never sent back.
create table analytics_db_connections (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  engine text not null check (engine in ('postgres', 'mysql', 'sqlserver')),
  host text not null check (length(host) between 1 and 253),
  port integer check (port is null or port between 1 and 65535),
  -- SQL Server's named instance (e.g. SQLEXPRESS), found through SQL Server Browser.
  instance_name text check (instance_name is null or (engine = 'sqlserver' and length(instance_name) between 1 and 16)),
  database_name text not null check (length(database_name) between 1 and 128),
  username text not null check (length(username) between 1 and 128),
  password_ciphertext text not null,
  encryption text not null default 'require' check (encryption in ('off', 'require', 'verify')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check (port is not null or instance_name is not null)
);
create unique index analytics_db_connections_name on analytics_db_connections (lower(name));

-- A source reads either a file (as before) or, through a connection, one
-- table or view or one typed SELECT, up to row_limit rows. file_name holds
-- what it reads for the load history ("Sales database › dbo.Orders").
alter table analytics_sources
  add column connection_id bigint references analytics_db_connections(id),
  add column db_schema text check (db_schema is null or length(db_schema) between 1 and 128),
  add column db_table text check (db_table is null or length(db_table) between 1 and 128),
  add column db_query text check (db_query is null or length(db_query) between 1 and 20000),
  add column row_limit integer check (row_limit is null or row_limit between 1 and 5000000),
  add constraint analytics_sources_reads_check check (
    (connection_id is null and db_schema is null and db_table is null and db_query is null and row_limit is null)
    or (connection_id is not null and row_limit is not null and sheet_name is null
        and ((db_table is not null and db_query is null) or (db_table is null and db_schema is null and db_query is not null)))
  );
create index analytics_sources_connection_idx on analytics_sources (connection_id) where connection_id is not null;
`,
  };
