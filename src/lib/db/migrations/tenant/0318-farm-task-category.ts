import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0318",
  name: "farm_task_category",
  sql: `
-- Farm tasks (FT9): a task can carry one category the farm chooses its own
-- words for ("Fencing", "Animal health"), so a long list can be narrowed
-- to one kind of job.
alter table farm_tasks add column category text check (category is null or length(category) between 1 and 40);
`,
};
