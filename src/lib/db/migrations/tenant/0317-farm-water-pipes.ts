import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0317",
  name: "farm_water_pipes",
  sql: `
-- Farm water (FW6): a mapped water pipe can carry its size, the flow it's
-- meant for and how far its far end rises, so the Water page can show what
-- each line does. Only pipes have them.
alter table farm_map_assets
  add column pipe_inside_mm numeric(6,1) check (pipe_inside_mm is null or pipe_inside_mm between 5 and 1000),
  add column pipe_flow_lpm numeric(8,1) check (pipe_flow_lpm is null or (pipe_flow_lpm > 0 and pipe_flow_lpm <= 100000)),
  add column pipe_rise_m numeric(6,1) check (pipe_rise_m is null or pipe_rise_m between -2000 and 2000),
  add constraint farm_map_assets_pipe_figures check (kind = 'pipe' or (pipe_inside_mm is null and pipe_flow_lpm is null and pipe_rise_m is null));
`,
};
