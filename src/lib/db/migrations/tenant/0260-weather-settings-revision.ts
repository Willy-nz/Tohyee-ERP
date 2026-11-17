import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0260",
    name: "weather_settings_revision",
    sql: `
-- Issue #619 findings 2 and 3. Each change to the key, what's fetched or
-- on/off adds one to revision; a refresh or connection test still waiting
-- on MetService checks it hasn't moved before it keeps anything or changes
-- the status. key_tested says the key saved now passed Test connection:
-- forecasts aren't fetched with a key until it has.
alter table weather_settings add column revision bigint not null default 0;
alter table weather_settings add column key_tested boolean not null default false;
update weather_settings set key_tested = true
  where api_key_ciphertext is not null and tested_at is not null and status not in ('not_tested', 'bad_key');
`,
  };
