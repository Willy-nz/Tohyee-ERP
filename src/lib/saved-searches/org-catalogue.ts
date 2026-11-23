import { getCustomFieldSetup } from "@/lib/custom-fields/service";
import { type CustomField, type CustomFieldRecord, type CustomFieldUse, fieldsFor } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { type FieldType, RECORD_TYPES, type RecordType, type SearchField } from "@/lib/saved-searches/catalogue";
import { getTrackingSetup } from "@/lib/tracking/service";

/**
 * An organisation's own additions to what a saved search can use: its custom
 * fields and its tracking categories, on the kinds of record that carry
 * them. Their ids come from the database and are checked to be digits before
 * they're written into SQL; values are still always parameters.
 */

/** Where each kind of record keeps custom fields: the JSON column, and which fields belong there. */
const CUSTOM: Record<string, Array<{ column: string; record: CustomFieldRecord; uses: CustomFieldUse[] }>> = {
  invoice: [{ column: "i.custom_fields", record: "document", uses: ["invoice"] }],
  bill: [{ column: "b.custom_fields", record: "document", uses: ["bill"] }],
  bank_transaction: [{ column: "t.custom_fields", record: "document", uses: ["spend", "receive"] }],
  contact: [{ column: "c.custom_fields", record: "contact", uses: ["customer", "supplier"] }],
  journal_line: [
    { column: "l.custom_fields", record: "line", uses: ["journal"] },
    { column: "j.custom_fields", record: "document", uses: ["journal"] },
  ],
};

/** Where tracking sits: on the row itself (a ledger line), or on the record's lines. */
const TRACKING: Record<string, { own: string } | { lines: string; link: string }> = {
  journal_line: { own: "l.tracking" },
  invoice: { lines: "sales_invoice_lines", link: "x.invoice_id = i.id" },
  bill: { lines: "bill_lines", link: "x.bill_id = b.id" },
  bank_transaction: { lines: "bank_transaction_lines", link: "x.bank_transaction_id = t.id" },
};

const DIGITS = /^\d{1,18}$/;

function customField(column: string, field: CustomField): SearchField | null {
  if (!DIGITS.test(field.id)) return null;
  const value = `(${column}->>'${field.id}')`;
  const base = { key: `cf_${field.id}`, label: field.label };
  switch (field.type) {
    case "text":
    case "long_text":
    case "email":
    case "phone":
    case "url":
      return { ...base, type: "text", sql: value };
    case "integer":
    case "decimal":
    case "percent":
      return { ...base, type: "number", sql: `${value}::numeric` };
    case "money":
      return { ...base, type: "money", sql: `${value}::numeric` };
    case "date":
      return { ...base, type: "date", sql: `${value}::date` };
    case "checkbox":
      return { ...base, type: "choice", sql: `coalesce(${value}, 'false')`, choices: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
    case "list":
      return { ...base, type: "choice", sql: value, choices: field.options.filter((option) => DIGITS.test(option.id)).map((option) => ({ value: option.id, label: option.name })) };
    default:
      // A field that holds several choices at once isn't one value to compare; it waits for a later stage.
      return null;
  }
}

/** The record types with this organisation's custom fields and tracking added. */
export async function loadRecordTypes(tx: OrgTx): Promise<RecordType[]> {
  const custom = await getCustomFieldSetup(tx);
  const tracking = await getTrackingSetup(tx);
  return RECORD_TYPES.map((type) => {
    const extra: SearchField[] = [];
    const taken = new Set(type.fields.map((field) => field.label.toLowerCase()));
    const add = (field: SearchField | null) => {
      if (!field) return;
      // Two fields can't read the same in the list of fields.
      const label = taken.has(field.label.toLowerCase()) ? `${field.label} (custom)` : field.label;
      taken.add(label.toLowerCase());
      extra.push({ ...field, label });
    };
    for (const place of CUSTOM[type.key] ?? []) {
      for (const field of fieldsFor(custom.fields, place.record, place.uses, {}, custom)) add(customField(place.column, field));
    }
    const where = TRACKING[type.key];
    if (where && tracking.advancedFeatures) {
      for (const category of tracking.categories) {
        if (!category.isActive || !DIGITS.test(category.id) || category.values.length === 0) continue;
        const choices = category.values.filter((value) => DIGITS.test(value.id)).map((value) => ({ value: value.id, label: value.path }));
        if ("own" in where) {
          add({ key: `tr_${category.id}`, label: category.name, type: "choice", sql: `(${where.own}->>'${category.id}')`, choices });
        } else {
          add({
            key: `tr_${category.id}`,
            label: `${category.name} (on any line)`,
            type: "choice",
            // The column shows each value its lines have; the filter asks whether any line has the one chosen.
            sql: `(select string_agg(distinct tv.name, ', ' order by tv.name) from ${where.lines} x join tracking_values tv on tv.id::text = x.tracking->>'${category.id}' where ${where.link})`,
            matchSql: `exists (select 1 from ${where.lines} x where ${where.link} and x.tracking->>'${category.id}' = $value)`,
            choices,
          });
        }
      }
    }
    return extra.length > 0 ? { ...type, fields: [...type.fields, ...extra] } : type;
  });
}

/** What the screen needs of a record type: no SQL. */
export type PublicRecordType = {
  key: string;
  label: string;
  singular: string;
  fields: Array<{ key: string; label: string; type: FieldType; choices?: Array<{ value: string; label: string }> }>;
  defaultColumns: string[];
  defaultSort: { field: string; direction: "asc" | "desc" };
};

export function publicRecordTypes(types: readonly RecordType[]): PublicRecordType[] {
  return types.map((type) => ({
    key: type.key,
    label: type.label,
    singular: type.singular,
    fields: type.fields.map((field) => ({ key: field.key, label: field.label, type: field.type, ...(field.choices ? { choices: [...field.choices] } : {}) })),
    defaultColumns: [...type.defaultColumns],
    defaultSort: { ...type.defaultSort },
  }));
}
