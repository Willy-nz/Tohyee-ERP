import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0266",
    name: "bank_redo_batches",
    sql: `
-- Remove & redo (BK45, decision 1574): a batch of its own, undoing no batch.
alter table batches drop constraint batches_kind_check;
alter table batches add constraint batches_kind_check
  check (kind in ('bank_reconcile', 'bank_unreconcile', 'bank_undo', 'bank_redo', 'bank_coding', 'mixed_use_review'));
`,
  };
