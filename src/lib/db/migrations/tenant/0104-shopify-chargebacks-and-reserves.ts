import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0104",
    name: "shopify_chargebacks_and_reserves",
    sql: `
-- Shopify chargebacks and reserves (item 7 part 1, examples SPC25-SPC31,
-- decisions 447-450): the account a disputed amount goes to, the bank
-- account money Shopify holds back sits in, and the further documents a
-- payout can become (a receive money for won disputes, transfers to and
-- from the reserve).
alter table sales_platform_connections
  add column chargebacks_account_id bigint references accounts(id),
  add column reserve_account_id bigint references accounts(id);

alter table sales_platform_documents
  add column receipt_bank_transaction_id bigint references bank_transactions(id),
  add column reserve_held_transfer_id bigint references bank_transfers(id),
  add column reserve_released_transfer_id bigint references bank_transfers(id);
`,
  };
