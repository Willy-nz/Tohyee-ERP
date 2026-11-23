import { ValidationError } from "@/lib/errors";
import { dec, toFixedString } from "@/lib/money/decimal";
import { DATE_RANGES, fieldOf, OPERATORS, type RecordType, type SearchField } from "@/lib/saved-searches/catalogue";

/**
 * A saved search's definition and the SQL it turns into. Pure: no database
 * here. Fields come from the catalogue and every value is a parameter, so a
 * search can only read what its record type allows.
 */

export type SearchFilter = { field: string; op: string; value?: string; value2?: string };
export type SearchDefinition = {
  filters: SearchFilter[];
  columns: string[];
  sort: { field: string; direction: "asc" | "desc" } | null;
};

export const MAX_FILTERS = 12;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(input: string): boolean {
  return ISO_DATE.test(input) && !Number.isNaN(Date.parse(`${input}T00:00:00Z`)) && new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) === input;
}

function cleanValue(field: SearchField, op: string, raw: unknown, which: string): string {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (text === "") throw new ValidationError(`${field.label}: give ${which}.`);
  if (text.length > 200) throw new ValidationError(`${field.label}: that's too long.`);
  if (field.type === "money" || field.type === "number") {
    const plain = text.replaceAll(",", "");
    if (!/^-?\d{1,12}(\.\d{1,4})?$/.test(plain)) throw new ValidationError(`${field.label}: "${text}" isn't a number.`);
    return field.type === "money" ? toFixedString(dec(plain), 2) : plain;
  }
  if (field.type === "date") {
    if (op === "within") {
      if (!DATE_RANGES.some((range) => range.value === text)) throw new ValidationError(`${field.label}: choose a range.`);
      return text;
    }
    if (!validDate(text)) throw new ValidationError(`${field.label}: "${text}" isn't a date.`);
    return text;
  }
  if (field.type === "choice") {
    if (!field.choices?.some((choice) => choice.value === text)) throw new ValidationError(`${field.label}: "${text}" isn't one of its choices.`);
    return text;
  }
  return text;
}

/** Checks a definition against its record type and returns it tidied: unknown fields and operators are refused, not dropped. */
export function parseDefinition(type: RecordType, input: unknown): SearchDefinition {
  if (!isRecord(input)) throw new ValidationError("A search needs filters, columns and a sort.");
  const rawFilters = input.filters === undefined ? [] : input.filters;
  if (!Array.isArray(rawFilters)) throw new ValidationError("filters is a list.");
  if (rawFilters.length > MAX_FILTERS) throw new ValidationError(`A search can have up to ${MAX_FILTERS} filters.`);
  const filters = rawFilters.map((raw): SearchFilter => {
    if (!isRecord(raw)) throw new ValidationError("Each filter names a field and how to compare it.");
    const field = fieldOf(type, raw.field);
    if (!field) throw new ValidationError(`${type.label} have no field "${String(raw.field)}".`);
    const operator = OPERATORS[field.type].find((each) => each.op === raw.op);
    if (!operator) throw new ValidationError(`${field.label} can't be filtered with "${String(raw.op)}".`);
    const filter: SearchFilter = { field: field.key, op: operator.op };
    if (operator.values >= 1) filter.value = cleanValue(field, operator.op, raw.value, operator.values === 2 ? "the first value" : "a value");
    if (operator.values === 2) filter.value2 = cleanValue(field, operator.op, raw.value2, "the second value");
    return filter;
  });
  const rawColumns = input.columns === undefined || (Array.isArray(input.columns) && input.columns.length === 0) ? [...type.defaultColumns] : input.columns;
  if (!Array.isArray(rawColumns)) throw new ValidationError("columns is a list.");
  const columns: string[] = [];
  for (const key of rawColumns) {
    const field = fieldOf(type, key);
    if (!field) throw new ValidationError(`${type.label} have no field "${String(key)}".`);
    if (!columns.includes(field.key)) columns.push(field.key);
  }
  let sort: SearchDefinition["sort"] = null;
  if (input.sort != null) {
    if (!isRecord(input.sort)) throw new ValidationError("sort names a field and a direction.");
    const field = fieldOf(type, input.sort.field);
    if (!field) throw new ValidationError(`${type.label} have no field "${String(input.sort.field)}".`);
    sort = { field: field.key, direction: input.sort.direction === "asc" ? "asc" : "desc" };
  }
  return { filters, columns, sort };
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A moving range as first and last day (either end may be open), from today's date. */
export function dateRange(range: string, today: string): { from: string | null; to: string | null } {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (range) {
    case "today":
      return { from: today, to: today };
    case "this_month": {
      const next = new Date(`${monthStart}T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return { from: monthStart, to: addDays(next.toISOString().slice(0, 10), -1) };
    }
    case "last_month": {
      const previous = new Date(`${monthStart}T00:00:00Z`);
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      return { from: previous.toISOString().slice(0, 10), to: addDays(monthStart, -1) };
    }
    case "last_7":
      return { from: addDays(today, -6), to: today };
    case "last_30":
      return { from: addDays(today, -29), to: today };
    case "last_90":
      return { from: addDays(today, -89), to: today };
    case "next_30":
      return { from: today, to: addDays(today, 30) };
    case "past":
      return { from: null, to: addDays(today, -1) };
    default:
      throw new ValidationError("Choose a date range.");
  }
}

export type BuiltSearch = {
  /** The page of rows: id, href_id, then one text column a chosen field (c0, c1, ...). */
  rowsSql: string;
  /** One row: how many match, a sum for each money or number column (s0, s1, ...), and how many currencies they're in. */
  summarySql: string;
  params: unknown[];
};

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Turns a checked definition into SQL. `today` is the organisation's date, for moving ranges and days overdue. */
export function buildSearch(type: RecordType, definition: SearchDefinition, options: { today: string; limit: number; offset: number }): BuiltSearch {
  const params: unknown[] = [];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const todayParam = param(options.today);
  const expression = (field: SearchField) => field.sql.replaceAll("$today", todayParam);
  const fieldByKey = (key: string) => fieldOf(type, key)!;

  // Today is named in both queries whether or not a chosen field uses it, so each has a use for every parameter it's sent.
  const where: string[] = [`${todayParam}::date is not null`];
  if (type.baseWhere) where.push(type.baseWhere);
  for (const filter of definition.filters) {
    const field = fieldByKey(filter.field);
    const sql = expression(field);
    const cast = field.type === "date" ? "::date" : field.type === "money" || field.type === "number" ? "::numeric" : "::text";
    switch (filter.op) {
      case "contains":
        where.push(`${sql} ilike ${param(`%${escapeLike(filter.value!)}%`)}`);
        break;
      case "starts":
        where.push(`${sql} ilike ${param(`${escapeLike(filter.value!)}%`)}`);
        break;
      case "is":
        if (field.matchSql) where.push(field.matchSql.replaceAll("$value", `${param(filter.value)}::text`));
        else where.push(field.type === "text" ? `lower(${sql}) = lower(${param(filter.value)}::text)` : `${sql} = ${param(filter.value)}${cast}`);
        break;
      case "is_not":
        if (field.matchSql) where.push(`not ${field.matchSql.replaceAll("$value", `${param(filter.value)}::text`)}`);
        else where.push(`${sql} is distinct from ${param(filter.value)}${cast}`);
        break;
      case "empty":
        where.push(`coalesce(${sql}, '') = ''`);
        break;
      case "not_empty":
        where.push(`coalesce(${sql}, '') <> ''`);
        break;
      case "eq":
      case "on":
        where.push(`${sql} = ${param(filter.value)}${cast}`);
        break;
      case "gt":
      case "after":
        where.push(`${sql} > ${param(filter.value)}${cast}`);
        break;
      case "gte":
        where.push(`${sql} >= ${param(filter.value)}${cast}`);
        break;
      case "lt":
      case "before":
        where.push(`${sql} < ${param(filter.value)}${cast}`);
        break;
      case "lte":
        where.push(`${sql} <= ${param(filter.value)}${cast}`);
        break;
      case "between":
        where.push(`${sql} between ${param(filter.value)}${cast} and ${param(filter.value2)}${cast}`);
        break;
      case "within": {
        const range = dateRange(filter.value!, options.today);
        if (range.from) where.push(`${sql} >= ${param(range.from)}::date`);
        if (range.to) where.push(`${sql} <= ${param(range.to)}::date`);
        break;
      }
      default:
        throw new ValidationError(`${field.label} can't be filtered with "${filter.op}".`);
    }
  }
  const whereSql = ` where ${where.join(" and ")}`;

  const columns = definition.columns.map(fieldByKey);
  const select = columns.map((field, index) => {
    const sql = expression(field);
    if (field.type === "date") return `to_char(${sql}, 'YYYY-MM-DD') as c${index}`;
    if (field.type === "money") return `(${sql})::numeric(18,2)::text as c${index}`;
    return `(${sql})::text as c${index}`;
  });
  const sort = definition.sort ?? type.defaultSort;
  const sortField = fieldByKey(sort.field);
  const sortSql = sortField.type === "text" ? `lower(${expression(sortField)})` : expression(sortField);
  const rowsSql = `select ${type.idSql}::text as id, ${type.hrefIdSql}::text as href_id${select.length ? `, ${select.join(", ")}` : ""}
    from ${type.from}${whereSql}
    order by ${sortSql} ${sort.direction} nulls last, ${type.idSql} desc
    limit ${Math.trunc(options.limit) + 1} offset ${Math.trunc(options.offset)}`;

  const sums = columns.map((field, index) => (field.type === "money" || field.type === "number" ? `, coalesce(sum(${expression(field)}), 0)::text as s${index}` : ""));
  const currency = type.currencyField ? `count(distinct ${expression(fieldByKey(type.currencyField))})::int` : "1";
  const summarySql = `select count(*)::int as matches, ${currency} as currencies${sums.join("")} from ${type.from}${whereSql}`;
  return { rowsSql, summarySql, params };
}
