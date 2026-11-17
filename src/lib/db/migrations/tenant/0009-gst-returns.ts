import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0009",
    name: "gst_returns",
    sql: `
-- GST returns (NZ GST101A, boxes 5-15) marked as filed. The figures are
-- worked out from approved documents when the return is filed and stored
-- as they were, with the Box 9 and Box 13 adjustments and every counted line,
-- so later approvals or voids dated in the period don't change what was
-- filed. Rows are only ever added: a filed return can't be changed or
-- deleted, and two filed returns can't cover the same day.
create table gst_returns (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  period_start date not null,
  period_end date not null,
  gst_basis text not null check (gst_basis in ('invoice', 'payments', 'hybrid')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  box5 numeric not null,
  box6 numeric not null,
  box7 numeric not null,
  box8 numeric not null,
  box9 numeric not null check (box9 >= 0),
  box10 numeric not null,
  box11 numeric not null,
  box12 numeric not null,
  box13 numeric not null check (box13 >= 0),
  box14 numeric not null,
  box15 numeric not null,
  sales_gst numeric not null,
  purchases_gst numeric not null,
  adjustment_count integer not null check (adjustment_count >= 0),
  line_count integer not null check (line_count >= 0),
  filed_by_user_id uuid,
  filed_by_email text not null,
  filed_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  -- 1, 2 or 6 whole calendar months: from the 1st to the last day of a month.
  check (extract(day from period_start) = 1),
  check (extract(day from period_end + 1) = 1),
  check ((extract(year from period_end) * 12 + extract(month from period_end))
         - (extract(year from period_start) * 12 + extract(month from period_start)) + 1 in (1, 2, 6)),
  check (box7 = box5 - box6),
  check (box8 = round(box7 * 3 / 23, 2)),
  check (box10 = box8 + box9),
  check (box12 = round(box11 * 3 / 23, 2)),
  check (box14 = box12 + box13),
  check (box15 = box10 - box14),
  constraint gst_returns_no_overlap exclude using gist (daterange(period_start, period_end, '[]') with &&)
);

-- Box 9 (debit) and Box 13 (credit) adjustments: GST amounts typed in, each
-- with what it's for.
create table gst_return_adjustments (
  id bigserial primary key,
  gst_return_id bigint not null references gst_returns(id),
  line_order integer not null check (line_order > 0),
  box text not null check (box in ('9', '13')),
  description text not null check (length(description) between 1 and 200),
  amount numeric not null check (amount > 0 and scale(amount) <= 2),
  unique (gst_return_id, line_order)
);

-- The document lines counted in the return, as they were when it was filed.
-- Amounts include GST and are negative for credit notes and voids.
create table gst_return_lines (
  id bigserial primary key,
  gst_return_id bigint not null references gst_returns(id),
  line_order integer not null check (line_order > 0),
  side text not null check (side in ('sales', 'purchases')),
  event_type text not null check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved',
    'credit_note_voided', 'bill_approved', 'bill_voided', 'supplier_credit_note_approved',
    'supplier_credit_note_voided')),
  event_date date not null,
  document_type text not null check (document_type in ('sales_invoice', 'sales_credit_note', 'bill',
    'supplier_credit_note')),
  document_id bigint not null,
  document_number text not null,
  reference text,
  contact_id bigint not null references contacts(id),
  contact_name text not null,
  document_line_order integer not null,
  description text not null,
  tax_code text,
  category text not null check (category in ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  tax_rate numeric not null,
  amount numeric not null,
  gst_amount numeric not null,
  boxes text[] not null check (cardinality(boxes) > 0 and boxes <@ array['5', '6', '11']),
  unique (gst_return_id, line_order)
);

-- Filed returns can't be changed, deleted or truncated.
create function tohyee_guard_gst_return() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated: filed GST returns are kept as they were filed', tg_table_name
      using errcode = 'P0001';
  end if;
  raise exception 'Filed GST return #% can''t be changed or deleted', old.id using errcode = 'P0001';
end;
$$;

-- Adjustments and lines are added only while their return is being filed:
-- each fills one of the return's numbered slots (adjustment_count or
-- line_count), so once they're all filled nothing more can be added. After
-- that they can't be changed, deleted or truncated.
create function tohyee_guard_gst_return_detail() returns trigger
language plpgsql as $$
declare
  slots integer;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated: filed GST returns are kept as they were filed', tg_table_name
      using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'Filed GST return #% can''t be changed or deleted', old.gst_return_id using errcode = 'P0001';
  end if;
  if tg_table_name = 'gst_return_adjustments' then
    select adjustment_count into slots from gst_returns where id = new.gst_return_id;
  else
    select line_count into slots from gst_returns where id = new.gst_return_id;
  end if;
  if slots is not null and new.line_order > slots then
    raise exception 'Filed GST return #% can''t be changed', new.gst_return_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- At commit, a filed return has all its adjustments and lines, and its boxes
-- are what they add up to.
create function tohyee_check_gst_return() returns trigger
language plpgsql as $$
declare
  lines record;
  adjustments record;
begin
  select count(*)::integer as line_count,
         coalesce(sum(amount) filter (where '5' = any(boxes)), 0) as box5,
         coalesce(sum(amount) filter (where '6' = any(boxes)), 0) as box6,
         coalesce(sum(amount) filter (where '11' = any(boxes)), 0) as box11,
         coalesce(sum(gst_amount) filter (where side = 'sales'), 0) as sales_gst,
         coalesce(sum(gst_amount) filter (where side = 'purchases'), 0) as purchases_gst
    into lines
    from gst_return_lines where gst_return_id = new.id;
  select count(*)::integer as adjustment_count,
         coalesce(sum(amount) filter (where box = '9'), 0) as box9,
         coalesce(sum(amount) filter (where box = '13'), 0) as box13
    into adjustments
    from gst_return_adjustments where gst_return_id = new.id;
  if lines.line_count <> new.line_count or adjustments.adjustment_count <> new.adjustment_count then
    raise exception 'GST return #% is missing some of its lines or adjustments', new.id using errcode = '23514';
  end if;
  if lines.box5 <> new.box5 or lines.box6 <> new.box6 or lines.box11 <> new.box11
     or lines.sales_gst <> new.sales_gst or lines.purchases_gst <> new.purchases_gst
     or adjustments.box9 <> new.box9 or adjustments.box13 <> new.box13 then
    raise exception 'GST return #% boxes don''t add up to its lines and adjustments', new.id using errcode = '23514';
  end if;
  return null;
end;
$$;

create trigger gst_returns_guard
  before update or delete on gst_returns
  for each row execute function tohyee_guard_gst_return();
create trigger gst_returns_no_truncate
  before truncate on gst_returns
  for each statement execute function tohyee_guard_gst_return();
create constraint trigger gst_returns_add_up
  after insert on gst_returns
  deferrable initially deferred
  for each row execute function tohyee_check_gst_return();
create trigger gst_return_adjustments_guard
  before insert or update or delete on gst_return_adjustments
  for each row execute function tohyee_guard_gst_return_detail();
create trigger gst_return_adjustments_no_truncate
  before truncate on gst_return_adjustments
  for each statement execute function tohyee_guard_gst_return_detail();
create trigger gst_return_lines_guard
  before insert or update or delete on gst_return_lines
  for each row execute function tohyee_guard_gst_return_detail();
create trigger gst_return_lines_no_truncate
  before truncate on gst_return_lines
  for each statement execute function tohyee_guard_gst_return_detail();
`,
  };
