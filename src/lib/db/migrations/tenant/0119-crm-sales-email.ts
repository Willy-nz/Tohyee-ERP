import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0119",
    name: "crm_sales_email",
    sql: `
-- Sales emails from the rep's own mailbox (decision 496, #216 stage 2).
-- A mailbox can send only after its owner allowed it (a second sign-in that
-- adds gmail.send or Mail.Send). Nothing is ever sent without a person
-- pressing Send.
alter table crm_connected_accounts add column can_send boolean not null default false;
alter table crm_oauth_states add column with_send boolean not null default false;

-- People and leads who asked not to be emailed.
alter table crm_people add column email_opt_out boolean not null default false;
alter table crm_leads add column email_opt_out boolean not null default false;

create table crm_email_templates (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 20000),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_email_templates_name on crm_email_templates (lower(name));

-- Each email sent from Tohyee. A retry with the same key returns this row
-- instead of sending again; one that may have gone is never retried.
create table crm_sent_emails (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references crm_connected_accounts(id),
  sent_by_user_id text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  template_id bigint references crm_email_templates(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  contact_id bigint references contacts(id),
  opportunity_id bigint references crm_opportunities(id),
  status text not null check (status in ('sending', 'sent', 'failed', 'maybe_sent')),
  error text,
  provider_message_id text,
  activity_id bigint references crm_activities(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (command_source, idempotency_key)
);
create index crm_sent_emails_lead on crm_sent_emails (lead_id);
create index crm_sent_emails_person on crm_sent_emails (person_id);
create index crm_sent_emails_opportunity on crm_sent_emails (opportunity_id);
`,
  };
