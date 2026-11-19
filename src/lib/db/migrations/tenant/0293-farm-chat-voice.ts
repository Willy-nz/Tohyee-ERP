import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0293",
    name: "farm_chat_voice",
    sql: `
-- Voice notes in farm chat (FCH9): how long each one is, as the recording
-- phone said, up to 3 minutes. Photos have no length.
alter table farm_chat_attachments add column seconds integer;
alter table farm_chat_attachments add constraint farm_chat_attachments_seconds_check check (
  (kind = 'photo' and seconds is null) or (kind = 'voice' and seconds between 1 and 180)
);
`,
};
