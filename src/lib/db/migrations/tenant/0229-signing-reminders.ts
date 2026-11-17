import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0229",
    name: "signing_reminders",
    sql: `
-- Reminders (decision 1410) are emailed by a scheduled job, which has no
-- request to read Tohyee's address from: the address the request was sent
-- from is kept for its links, used when remote access has no public address.
alter table signing_requests add column link_origin text check (link_origin is null or (length(link_origin) <= 300 and link_origin ~ '^https?://[^\\s]+$'));
create index signing_requests_reminders on signing_requests (last_reminded_at) where status = 'sent' and remind_every_days is not null;
`,
  };
