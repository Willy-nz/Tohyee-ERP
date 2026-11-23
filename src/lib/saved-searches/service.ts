import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { toCsv } from "@/lib/csv";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { dec, toFixedString } from "@/lib/money/decimal";
import { type FieldType, fieldOf, type RecordType, recordType } from "@/lib/saved-searches/catalogue";
import { loadRecordTypes } from "@/lib/saved-searches/org-catalogue";
import { buildSearch, parseDefinition, type SearchDefinition } from "@/lib/saved-searches/query";
import { asRecord, optionalId, requireId, requireString } from "@/lib/validation";

/**
 * Saved searches: a list of one kind of record, filtered, with chosen
 * columns and a sort, kept under a name. They read the live books every time
 * and store no figures. A search is its maker's own until it's shared;
 * shared ones can be opened by anyone who can see the books and changed by
 * their maker or an admin.
 */

export type SavedSearch = {
  id: string;
  recordType: string;
  recordLabel: string;
  name: string;
  definition: SearchDefinition;
  shared: boolean;
  mine: boolean;
  /** Whether this person can change or delete it. */
  canEdit: boolean;
  ownerEmail: string;
  updatedAt: string;
};

type Row = { id: string; record_type: string; name: string; definition: unknown; shared: boolean; owner_user_id: string | null; owner_email: string; updated_at: Date | string };

function isMine(tx: OrgTx, row: Row): boolean {
  return row.owner_user_id !== null ? row.owner_user_id === tx.actor.userId : row.owner_email === tx.actor.email;
}

function isAdmin(tx: OrgTx): boolean {
  // Work with no role on it (a test, Tohyee itself) is trusted as the routes' own role checks have passed.
  return tx.actor.role === undefined || roleAtLeast(tx.actor.role, "admin");
}

function requireType(types: readonly RecordType[], key: unknown): RecordType {
  const type = recordType(key, types);
  if (!type) throw new ValidationError(`Choose what to search: ${types.map((each) => each.label).join(", ")}.`);
  return type;
}

function toSaved(tx: OrgTx, types: readonly RecordType[], row: Row): SavedSearch | null {
  const type = recordType(row.record_type, types);
  // A search for a kind of record this version no longer has is left out, not broken.
  if (!type) return null;
  let definition: SearchDefinition;
  try {
    definition = parseDefinition(type, row.definition);
  } catch {
    // A field it used has gone: it opens with the usual columns and no filters, to be fixed and saved again.
    definition = parseDefinition(type, {});
  }
  const mine = isMine(tx, row);
  return {
    id: row.id,
    recordType: type.key,
    recordLabel: type.label,
    name: row.name,
    definition,
    shared: row.shared,
    mine,
    canEdit: mine || isAdmin(tx),
    ownerEmail: row.owner_email,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT = "select id::text, record_type, name, definition, shared, owner_user_id::text, owner_email, updated_at from saved_searches";

/** This person's searches and the shared ones, by name. */
export async function listSavedSearches(tx: OrgTx): Promise<SavedSearch[]> {
  const result = await tx.query<Row>(`${SELECT} where shared or owner_user_id = $1 or (owner_user_id is null and owner_email = $2) order by lower(name), id`, [tx.actor.userId, tx.actor.email]);
  const types = await loadRecordTypes(tx);
  return result.rows.map((row) => toSaved(tx, types, row)).filter((search): search is SavedSearch => search !== null);
}

async function loadRow(tx: OrgTx, idInput: unknown, lock = false): Promise<Row> {
  const id = requireId(idInput, "searchId");
  const result = await tx.query<Row>(`${SELECT} where id = $1${lock ? " for update" : ""}`, [id]);
  const row = result.rows[0];
  // Someone else's private search isn't there, as far as this person can tell.
  if (!row || !(row.shared || isMine(tx, row))) throw new NotFoundError("That saved search wasn't found.");
  return row;
}

export async function getSavedSearch(tx: OrgTx, idInput: unknown): Promise<SavedSearch> {
  const saved = toSaved(tx, await loadRecordTypes(tx), await loadRow(tx, idInput));
  if (!saved) throw new NotFoundError("That saved search wasn't found.");
  return saved;
}

/** Saves a new search, or changes one (`id`). Sharing one with everyone is for bookkeepers and above. */
export async function saveSavedSearch(tx: OrgTx, bodyInput: unknown): Promise<SavedSearch> {
  const body = asRecord(bodyInput, "body");
  const id = optionalId(body.id, "id");
  const name = requireString(body.name, "A name", { maxLength: 80 });
  const shared = body.shared === true;
  if (shared && tx.actor.role !== undefined && !roleAtLeast(tx.actor.role, "bookkeeper")) throw new ForbiddenError("Sharing a search with everyone is for bookkeepers and above.");
  if (id) {
    const row = await loadRow(tx, id, true);
    if (!(isMine(tx, row) || isAdmin(tx))) throw new ForbiddenError("Only the person who made a shared search, or an admin, can change it. Save your own copy instead.");
    // A saved search keeps its kind of record: another kind is another search.
    const type = requireType(await loadRecordTypes(tx), row.record_type);
    const definition = parseDefinition(type, body.definition);
    await tx.query("update saved_searches set name = $2, definition = $3::jsonb, shared = $4, updated_at = now(), updated_by_email = $5 where id = $1", [id, name, JSON.stringify(definition), shared, tx.actor.email]);
    await writeAuditEvent(tx, { eventType: "saved_search.changed", entityType: "saved_search", entityId: id, details: { name, shared, recordType: type.key } });
    return getSavedSearch(tx, id);
  }
  const type = requireType(await loadRecordTypes(tx), body.recordType);
  const definition = parseDefinition(type, body.definition);
  const inserted = await tx.query<{ id: string }>(
    `insert into saved_searches (record_type, name, definition, shared, owner_user_id, owner_email, updated_by_email) values ($1, $2, $3::jsonb, $4, $5, $6, $6) returning id::text`,
    [type.key, name, JSON.stringify(definition), shared, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "saved_search.created", entityType: "saved_search", entityId: inserted.rows[0].id, details: { name, shared, recordType: type.key } });
  return getSavedSearch(tx, inserted.rows[0].id);
}

export async function deleteSavedSearch(tx: OrgTx, idInput: unknown): Promise<void> {
  const row = await loadRow(tx, idInput, true);
  if (!(isMine(tx, row) || isAdmin(tx))) throw new ForbiddenError("Only the person who made a shared search, or an admin, can delete it.");
  await tx.query("delete from saved_searches where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "saved_search.deleted", entityType: "saved_search", entityId: row.id, details: { name: row.name, recordType: row.record_type } });
}

export type SearchColumn = { key: string; label: string; type: FieldType; choices?: Record<string, string> };

export type SearchResult = {
  recordType: string;
  columns: SearchColumn[];
  rows: Array<{ id: string; href: string; cells: Array<string | null> }>;
  /** How many records match in all, not just on this page. */
  matches: number;
  /** A total for each money column, over every match; null for other columns, and when the matches are in more than one currency. */
  totals: Array<string | null>;
  nextOffset: number | null;
};

const PAGE = 100;

/** Runs a definition against the live books. `today` can be given by a test; otherwise it's the business's date. */
export async function runSearch(tx: OrgTx, input: { recordType: unknown; definition: unknown; offset?: unknown; limit?: unknown; today?: string }): Promise<SearchResult> {
  const type = requireType(await loadRecordTypes(tx), input.recordType);
  const definition = parseDefinition(type, input.definition ?? {});
  const offsetRaw = Number(input.offset ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 && offsetRaw <= 1_000_000 ? offsetRaw : 0;
  const limitRaw = Number(input.limit ?? PAGE);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 5000 ? limitRaw : PAGE;
  const built = buildSearch(type, definition, { today: input.today ?? todayIsoDate(), limit, offset });
  const fields = definition.columns.map((key) => fieldOf(type, key)!);
  const page = await tx.query<Record<string, string | null>>(built.rowsSql, built.params);
  const summary = (await tx.query<Record<string, string | number>>(built.summarySql, built.params)).rows[0];
  const rows = page.rows.slice(0, limit);
  return {
    recordType: type.key,
    columns: fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.choices ? { choices: Object.fromEntries(field.choices.map((choice) => [choice.value, choice.label])) } : {}),
    })),
    rows: rows.map((row) => ({ id: row.id as string, href: type.href.replace("{id}", row.href_id as string), cells: fields.map((_, index) => row[`c${index}`] ?? null) })),
    matches: Number(summary.matches),
    totals: fields.map((field, index) => {
      if (field.type === "money") return Number(summary.currencies) > 1 ? null : toFixedString(dec(String(summary[`s${index}`])), 2);
      return null;
    }),
    nextOffset: page.rows.length > limit ? offset + limit : null,
  };
}

/** A search's rows as a CSV file: up to 5,000, with choices in words. */
export async function searchFile(tx: OrgTx, input: { recordType: unknown; definition: unknown; name?: unknown }): Promise<{ fileName: string; csv: string }> {
  const result = await runSearch(tx, { recordType: input.recordType, definition: input.definition, limit: 5000 });
  const rows: string[][] = [result.columns.map((column) => column.label)];
  for (const row of result.rows) rows.push(row.cells.map((cell, index) => (cell === null ? "" : (result.columns[index].choices?.[cell] ?? cell))));
  const slug = (typeof input.name === "string" && input.name.trim() ? input.name : result.recordType).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "search";
  await writeAuditEvent(tx, { eventType: "saved_search.exported", entityType: "saved_search", entityId: "0", details: { recordType: result.recordType, rows: result.rows.length, matches: result.matches } });
  return { fileName: `${slug}.csv`, csv: toCsv(rows) };
}
