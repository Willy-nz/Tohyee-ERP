import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0012",
    name: "ai_full_access",
    sql: `
-- A fourth AI key level, "Full access" (decision 488, #205): it also
-- reconciles bank statement lines and makes and edits bank rules. Only
-- Owners make one; it works as "post" when its owner isn't an Owner.
alter table ai_access_tokens drop constraint ai_access_tokens_access_level_check;
alter table ai_access_tokens add constraint ai_access_tokens_access_level_check
  check (access_level in ('read', 'draft', 'post', 'full'));
`,
  };
