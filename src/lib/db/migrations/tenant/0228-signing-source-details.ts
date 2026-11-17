import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0228",
    name: "signing_source_details",
    sql: `
-- What a signing request's document showed, for the thing it's for (decision
-- 1409): an induction's version, the hazards (id and version) and the
-- emergency details' version in its PDF, so the sign-off records exactly
-- what was signed. Fixed with the rest of the request once it's sent.
alter table signing_requests add column source_details jsonb not null default '{}'::jsonb;
`,
  };
