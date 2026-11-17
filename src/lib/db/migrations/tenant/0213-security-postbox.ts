import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0213",
    name: "security_postbox",
    sql: `
-- The camera post box (decisions 1226-1233): a small program on a rented
-- online server that cameras upload to, which Tohyee collects from. One
-- per organisation. The key pair files are sealed to stays across
-- re-pairing (so files already waiting still open); the private key and
-- the token are encrypted with the server's secret key, never kept plain.
-- What the post box last said (files waiting, disk) is what Tohyee was
-- told when it collected, never typed in.
create table security_postbox (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_key_ciphertext text not null,
  address text,
  https_port integer check (https_port is null or https_port between 1 and 65535),
  tls_mode text check (tls_mode is null or tls_mode in ('pinned', 'public')),
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  paired_at timestamptz,
  paired_by_email text,
  ftp_address text,
  ftp_port integer,
  passive_ports text,
  box_version text,
  last_contact_at timestamptz,
  last_collected_at timestamptz,
  collected_total bigint not null default 0,
  files_waiting integer,
  bytes_waiting bigint,
  disk_free_bytes bigint,
  disk_total_bytes bigint,
  low_disk boolean not null default false,
  logins_version text,
  logins_pushed_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  last_error_kind text check (last_error_kind is null or last_error_kind in ('unreachable', 'certificate_changed', 'token_refused', 'box_error', 'file_failed')),
  last_error_at timestamptz,
  check ((token_ciphertext is null) = (address is null)),
  check ((address is null) = (tls_mode is null))
);
`,
  };
