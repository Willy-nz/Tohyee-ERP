import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0019",
    name: "office_addin_connections",
    sql: `
-- The PowerPoint add-in for Analytics (#429, decisions 830-849). It signs in
-- with the same OAuth as AI apps, but its tokens are for a different
-- address (<remote>/api/office), only read Analytics, and belong to the
-- person rather than one organisation (it lists all of theirs). A
-- connection of kind 'office' is a row like an AI app's, with no
-- organisation, always the read level; the MCP endpoint only accepts kind
-- 'connection', and the Analytics API for Office only kind 'office'.
alter table ai_access_tokens drop constraint ai_access_tokens_kind_check;
alter table ai_access_tokens add constraint ai_access_tokens_kind_check check (kind in ('key', 'connection', 'office'));
alter table ai_access_tokens drop constraint ai_access_tokens_kind_shape;
alter table ai_access_tokens add constraint ai_access_tokens_kind_shape check (
  (kind = 'key' and token_hash is not null and token_prefix is not null and oauth_client_id is null and redirect_uri is null and resource is null)
  or (kind in ('connection', 'office') and token_hash is null and token_prefix is null and oauth_client_id is not null and redirect_uri is not null and resource is not null)
);
alter table ai_access_tokens alter column organisation_id drop not null;
alter table ai_access_tokens add constraint ai_access_tokens_office_shape check (
  (kind = 'office') = (organisation_id is null) and (kind <> 'office' or access_level = 'read')
);
create index ai_access_tokens_office_owner on ai_access_tokens (user_id) where kind = 'office';

-- A code for the add-in has no organisation: the person picks one in PowerPoint.
alter table oauth_authorization_codes add column kind text not null default 'connection' check (kind in ('connection', 'office'));
alter table oauth_authorization_codes alter column organisation_id drop not null;
alter table oauth_authorization_codes add constraint oauth_authorization_codes_office_shape check (
  (kind = 'office') = (organisation_id is null) and (kind <> 'office' or access_level = 'read')
);
`,
  };
