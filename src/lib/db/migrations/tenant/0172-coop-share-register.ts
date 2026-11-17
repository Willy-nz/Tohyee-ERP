import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0172",
    name: "coop_share_register",
    sql: `
-- The co-op share register (#327, examples CSR1-CSR9, decisions 630-633):
-- a farming organisation's shares in co-operatives (Fonterra, Ballance,
-- Ravensdown, Silver Fern Farms and the like), one row per co-op and share
-- class, with every movement and every dividend, rebate and retention as
-- the co-op's statements show them. Nothing here posts to the ledger.
create table coop_shareholdings (
  id bigserial primary key,
  coop_name text not null check (length(coop_name) between 1 and 100),
  share_class text not null check (length(share_class) between 1 and 100),
  notes text check (notes is null or length(notes) between 1 and 1000),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_by_email text,
  removed_at timestamptz,
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create unique index coop_shareholdings_name_idx on coop_shareholdings (lower(coop_name), lower(share_class)) where status = 'active';

-- Signed changes: a sale is a negative quantity and value. Quantities to 4
-- places (some co-ops issue part shares), values to the cent.
create table coop_share_movements (
  id bigserial primary key,
  holding_id bigint not null references coop_shareholdings(id),
  movement_date date not null,
  kind text not null check (kind in ('brought_forward', 'bought', 'issued', 'sold', 'adjusted')),
  quantity numeric(18, 4) not null,
  value numeric(18, 2) not null,
  source_reference text check (source_reference is null or length(source_reference) between 1 and 200),
  attachment_id bigint references record_attachments(id),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_by_email text,
  removed_at timestamptz,
  check (source_reference is not null or attachment_id is not null),
  check (kind <> 'brought_forward' or (quantity >= 0 and value >= 0)),
  check (kind not in ('bought', 'issued') or (quantity > 0 and value >= 0)),
  check (kind <> 'sold' or (quantity < 0 and value <= 0)),
  check (kind <> 'adjusted' or quantity <> 0 or value <> 0),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create index coop_share_movements_holding_idx on coop_share_movements (holding_id, movement_date, id) where status = 'active';

-- Dividends, rebates and retentions, each kept apart from the shares and
-- from each other. Imputation credits only on dividends.
create table coop_share_distributions (
  id bigserial primary key,
  holding_id bigint not null references coop_shareholdings(id),
  paid_on date not null,
  kind text not null check (kind in ('dividend', 'rebate', 'retention')),
  amount numeric(18, 2) not null check (amount > 0),
  imputation_credits numeric(18, 2) check (imputation_credits is null or imputation_credits >= 0),
  source_reference text check (source_reference is null or length(source_reference) between 1 and 200),
  attachment_id bigint references record_attachments(id),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_by_email text,
  removed_at timestamptz,
  check (source_reference is not null or attachment_id is not null),
  check (kind = 'dividend' or imputation_credits is null),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create index coop_share_distributions_holding_idx on coop_share_distributions (holding_id, paid_on, id) where status = 'active';

-- Rows are only ever marked removed, never deleted.
create trigger coop_shareholdings_no_delete before delete on coop_shareholdings for each row execute function toeyee_forbid_delete();
create trigger coop_share_movements_no_delete before delete on coop_share_movements for each row execute function toeyee_forbid_delete();
create trigger coop_share_distributions_no_delete before delete on coop_share_distributions for each row execute function toeyee_forbid_delete();

-- The co-op's statements are files on the holding.
alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit', 'soil_test',
                         'coop_shareholding'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit', 'soil_test',
                         'coop_shareholding'));
`,
  };
