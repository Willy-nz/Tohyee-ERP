import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0044",
    name: "google_sending",
    sql: `
-- Sending documents through a Gmail or Google Workspace mailbox an admin
-- signs in to (OAuth 2.0 with the organisation's own Google app, the one the
-- CRM's mail sync uses, and the Gmail API's messages.send with the
-- gmail.send scope), alongside SMTP and Microsoft. Tokens are encrypted with
-- TOHYEE_SECRET_KEY and never sent to the browser. The other methods' details
-- stay saved while Google is chosen.
alter table organisation_email_settings drop constraint organisation_email_settings_sending_method_check;
alter table organisation_email_settings add constraint organisation_email_settings_sending_method_check
  check (sending_method in ('smtp', 'microsoft', 'google'));
alter table organisation_email_settings
  add column google_email text check (google_email is null or length(google_email) between 3 and 254),
  add column google_refresh_token_ciphertext text,
  add column google_access_token_ciphertext text,
  add column google_access_token_expires_at timestamptz,
  add column google_connected_by_email text,
  add column google_connected_at timestamptz;
alter table organisation_email_settings add constraint organisation_email_settings_google_complete check (
  (google_email is null) = (google_refresh_token_ciphertext is null)
  and (google_email is null) = (google_connected_at is null));
alter table organisation_email_settings drop constraint organisation_email_settings_method_ready;
alter table organisation_email_settings add constraint organisation_email_settings_method_ready check (
  (sending_method = 'smtp' and smtp_host is not null) or (sending_method = 'microsoft' and microsoft_email is not null)
  or (sending_method = 'google' and google_email is not null));

-- Which provider each one-time sign-in state was made for, so a state from
-- one sign-in can't be finished at the other's callback.
alter table email_oauth_states add column provider text not null default 'microsoft' check (provider in ('microsoft', 'google'));

-- How each email went: through SMTP, Microsoft Graph or the Gmail API.
alter table document_emails drop constraint document_emails_sent_via_check;
alter table document_emails add constraint document_emails_sent_via_check check (sent_via in ('smtp', 'microsoft', 'google'));
`,
  };
