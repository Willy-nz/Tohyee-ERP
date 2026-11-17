import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0027",
    name: "ai_tool_scope",
    sql: `
-- Which tools a key or connected app is for (#696, decision 1630). Null is
-- every tool its level allows, as before; 'reports' is the books' reports
-- and Analytics only. It narrows what the level allows and never adds to it.
-- The consent screen's choice travels on the code to the connection.
alter table ai_access_tokens add column tool_scope text check (tool_scope in ('reports'));
alter table oauth_authorization_codes add column tool_scope text check (tool_scope in ('reports'));
`,
  };
