import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0177",
    name: "analytics_dashboard_images",
    sql: `
-- Images placed on an Analytics report (#376 phase 2, decision 684):
-- stored in the organisation's own database like other attachments, and
-- served only to people who can see the report. JPG and PNG only, checked
-- against their contents before they're stored. They go with the report:
-- deleting the report deletes them, and saving a report removes images no
-- tile uses any more.
create table analytics_dashboard_images (
  id bigserial primary key,
  dashboard_id bigint not null references analytics_dashboards (id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  content bytea not null check (octet_length(content) = byte_size),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index analytics_dashboard_images_dashboard on analytics_dashboard_images (dashboard_id);
`,
  };
