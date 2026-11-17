import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0037",
    name: "microsoft_sending_and_logo",
    sql: `
-- Sending documents through a Microsoft 365 or Outlook mailbox the admin
-- signs in to (OAuth 2.0 with the organisation's own Microsoft app, the one
-- the CRM's mail sync uses, and Microsoft Graph's sendMail), as well as
-- through SMTP. The tokens are encrypted with TOHYEE_SECRET_KEY, like the
-- SMTP password, and never sent to the browser. SMTP details stay saved when
-- the Microsoft mailbox is chosen, and the other way round.
alter table organisation_email_settings
  add column sending_method text not null default 'smtp' check (sending_method in ('smtp', 'microsoft')),
  add column microsoft_email text check (microsoft_email is null or length(microsoft_email) between 3 and 254),
  add column microsoft_refresh_token_ciphertext text,
  add column microsoft_access_token_ciphertext text,
  add column microsoft_access_token_expires_at timestamptz,
  add column microsoft_connected_by_email text,
  add column microsoft_connected_at timestamptz;
alter table organisation_email_settings
  alter column smtp_host drop not null,
  alter column smtp_port drop not null,
  alter column smtp_security drop not null,
  alter column smtp_username drop not null,
  alter column smtp_password_ciphertext drop not null;
alter table organisation_email_settings add constraint organisation_email_settings_smtp_complete check (
  (smtp_host is null) = (smtp_port is null) and (smtp_host is null) = (smtp_security is null)
  and (smtp_host is null) = (smtp_username is null) and (smtp_host is null) = (smtp_password_ciphertext is null));
alter table organisation_email_settings add constraint organisation_email_settings_microsoft_complete check (
  (microsoft_email is null) = (microsoft_refresh_token_ciphertext is null)
  and (microsoft_email is null) = (microsoft_connected_at is null));
alter table organisation_email_settings add constraint organisation_email_settings_method_ready check (
  (sending_method = 'smtp' and smtp_host is not null) or (sending_method = 'microsoft' and microsoft_email is not null));

-- One-time sign-in states for connecting the sending mailbox (15 minutes, once).
create table email_oauth_states (
  state text primary key,
  user_id text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

-- How each email went: through SMTP or Microsoft Graph.
alter table document_emails add column sent_via text check (sent_via in ('smtp', 'microsoft'));

-- The organisation's logo, on emails, PDFs and printed documents. Stored in
-- the organisation's own database so its backup includes it; replacing it
-- replaces the row.
create table organisation_logo (
  id boolean primary key default true check (id),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('image/png', 'image/jpeg')),
  byte_size integer not null check (byte_size between 1 and 524288),
  width integer not null check (width between 1 and 4000),
  height integer not null check (height between 1 and 4000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) = byte_size),
  uploaded_by_email text not null,
  uploaded_at timestamptz not null default now()
);
`,
  };
