import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0261",
    name: "weather_records_acknowledgement",
    sql: `
-- A responsibility acknowledgement replaces the permission date/reference requirement.
-- Preserve previously supplied details and files; do not invent permission evidence.
alter table weather_settings drop constraint weather_settings_permission_details;
`,
  };
