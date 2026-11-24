import { ValidationError } from "@/lib/errors";
import type { RecordType, SearchField } from "@/lib/saved-searches/catalogue";

/**
 * Calculated columns on a saved search: sums over a record's own number and
 * money fields, such as {total} - {owing}. A small grammar of its own (plus,
 * minus, times, divide, brackets, numbers and fields in curly brackets) is
 * read here and written back out as SQL from the catalogue's expressions, so
 * nothing typed is ever run as it stands. Dividing by zero gives an empty
 * cell, not an error.
 */

export type SearchFormula = { key: string; label: string; expression: string };

export const MAX_FORMULAS = 5;
const KEY = /^f[1-5]$/;

type Token = { kind: "number" | "field" | "op"; text: string };

function tokens(label: string, text: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const number = /^\d{1,12}(\.\d{1,6})?/.exec(rest);
    if (number) {
      out.push({ kind: "number", text: number[0] });
      at += number[0].length;
      continue;
    }
    const field = /^\{([A-Za-z0-9_]{1,40})\}/.exec(rest);
    if (field) {
      out.push({ kind: "field", text: field[1] });
      at += field[0].length;
      continue;
    }
    if ("+-*/()".includes(rest[0])) {
      out.push({ kind: "op", text: rest[0] });
      at += 1;
      continue;
    }
    throw new ValidationError(`${label}: "${rest.slice(0, 10)}" isn't something a sum can use. Use numbers, + - * / ( ) and fields in curly brackets.`);
  }
  return out;
}

/** One formula as SQL over the record's fields. */
export function formulaSql(type: RecordType, formula: { label: string; expression: string }): string {
  const list = tokens(formula.label, formula.expression);
  if (list.length === 0) throw new ValidationError(`${formula.label}: write the sum, e.g. {total} - {owing}.`);
  if (list.length > 60) throw new ValidationError(`${formula.label}: that sum is too long.`);
  let at = 0;
  let depth = 0;
  const peek = () => list[at];
  const take = () => list[at++];
  const isOp = (text: string) => peek()?.kind === "op" && peek().text === text;

  function factor(): string {
    const token = take();
    if (!token) throw new ValidationError(`${formula.label}: the sum stops part way.`);
    if (token.kind === "number") return `${token.text}::numeric`;
    if (token.kind === "field") {
      const field = type.fields.find((each) => each.key === token.text);
      if (!field) throw new ValidationError(`${formula.label}: ${type.label} have no field {${token.text}}.`);
      if (field.type !== "money" && field.type !== "number") throw new ValidationError(`${formula.label}: {${token.text}} isn't a number, so it can't be in a sum.`);
      return `coalesce((${field.sql})::numeric, 0)`;
    }
    if (token.text === "-") return `(- ${factor()})`;
    if (token.text === "(") {
      depth += 1;
      if (depth > 8) throw new ValidationError(`${formula.label}: too many brackets inside brackets.`);
      const inner = sum();
      if (!isOp(")")) throw new ValidationError(`${formula.label}: a bracket isn't closed.`);
      take();
      depth -= 1;
      return `(${inner})`;
    }
    throw new ValidationError(`${formula.label}: "${token.text}" is in the wrong place.`);
  }
  function product(): string {
    let left = factor();
    while (isOp("*") || isOp("/")) {
      const op = take().text;
      const right = factor();
      left = op === "*" ? `(${left} * ${right})` : `(${left} / nullif(${right}, 0))`;
    }
    return left;
  }
  function sum(): string {
    let left = product();
    while (isOp("+") || isOp("-")) {
      const op = take().text;
      left = `(${left} ${op} ${product()})`;
    }
    return left;
  }
  const sql = sum();
  if (at < list.length) throw new ValidationError(`${formula.label}: "${list[at].text}" is in the wrong place.`);
  return `round(${sql}, 2)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the formulas on a definition; each must stand on the record's own fields, not on another formula. */
export function parseFormulas(type: RecordType, input: unknown): SearchFormula[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ValidationError("formulas is a list.");
  if (input.length > MAX_FORMULAS) throw new ValidationError(`A search can have up to ${MAX_FORMULAS} calculated columns.`);
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!isRecord(raw)) throw new ValidationError("Each calculated column has a name and a sum.");
    const key = typeof raw.key === "string" ? raw.key : "";
    if (!KEY.test(key) || seen.has(key)) throw new ValidationError("Calculated columns are f1 to f5, each used once.");
    seen.add(key);
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (label.length < 1 || label.length > 40) throw new ValidationError("Give each calculated column a name of up to 40 letters.");
    const expression = typeof raw.expression === "string" ? raw.expression.trim() : "";
    if (expression.length > 200) throw new ValidationError(`${label}: that sum is too long.`);
    formulaSql(type, { label, expression });
    return { key, label, expression };
  });
}

/** Money added to or taken from money is still money, shown and totalled as such; anything multiplied or divided is a plain number. */
function isMoney(type: RecordType, expression: string): boolean {
  if (/[*/]/.test(expression)) return false;
  const used = [...expression.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => type.fields.find((field) => field.key === match[1]));
  return used.length > 0 && used.every((field) => field?.type === "money") && !/(^|[^{A-Za-z0-9_.])\d/.test(expression);
}

/** The record type with a search's calculated columns added as number or money fields. */
export function withFormulas(type: RecordType, formulas: readonly SearchFormula[]): RecordType {
  if (formulas.length === 0) return type;
  const extra: SearchField[] = formulas.map((formula) => ({ key: formula.key, label: formula.label, type: isMoney(type, formula.expression) ? "money" : "number", sql: formulaSql(type, formula) }));
  return { ...type, fields: [...type.fields, ...extra] };
}
