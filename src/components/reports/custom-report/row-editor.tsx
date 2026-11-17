"use client";

import { useState } from "react";
import { Button,Card,Field,Notice,ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_TYPES,type AccountType } from "@/lib/accounts/types";
import {
type ComputedBlock,CUSTOM_REPORT_LIMITS,
type CustomReportBase,type FormulaTerm,
FORMULA_OPERATIONS,
type FormulaOperation,type ReportBlock,type ReportRow
} from "@/lib/reports/custom-layout";
import { InfoTip } from "@/components/info-tip";

/** The rows a formula uses (browser-side copy of the server's check). */
export function formulaRows(row: Extract<ReportRow, { kind: "formula" }>): string[] {
  return (row.operation ?? "sum") === "sum" ? row.terms.map((term) => term.rowId) : [row.a ?? "", ...(row.b ? [row.b] : [])];
}

export function RowEditor({
  base,
  table,
  initial,
  isNew,
  accounts,
  busy,
  onSave,
  onCancel,
}: {
  base: CustomReportBase;
  table: Extract<ReportBlock, { kind: "table" }>;
  initial: ReportRow;
  isNew: boolean;
  accounts: Account[];
  busy: boolean;
  onSave: (row: ReportRow) => void;
  onCancel: () => void;
}) {
  const [row, setRow] = useState<ReportRow>(initial);
  const [byCode, setByCode] = useState(initial.kind === "group" && initial.accountCodes.length > 0);
  const [error, setError] = useState<string | null>(null);
  // Rows a formula can use: not headings, and not a % (CR17).
  const others = table.rows.filter((entry) => entry.id !== row.id && entry.kind !== "heading" && !(entry.kind === "formula" && entry.operation === "percent"));
  const kindName = {
    group: "group of accounts",
    formula: "formula",
    heading: "heading",
    earnings: "earnings row",
  }[row.kind];

  function save() {
    if (!row.label.trim()) return setError("Give the row a name.");
    if (row.kind === "group") {
      const cleaned = byCode ? { ...row, accountTypes: [] } : { ...row, accountCodes: [] };
      if (cleaned.accountTypes.length === 0 && cleaned.accountCodes.length === 0) return setError("Tick the account types or accounts in this group.");
      return onSave({ ...cleaned, label: row.label.trim() });
    }
    if (row.kind === "formula" && (row.operation ?? "sum") === "sum" && row.terms.length === 0) return setError("Add at least one row to the formula.");
    if (row.kind === "formula" && (row.operation ?? "sum") !== "sum") {
      if (!row.a) return setError("Choose the first row.");
      if (!row.b && !row.by) return setError(row.operation === "percent" ? "Choose the row it's a % of." : "Choose the second row, or type a number.");
      if (row.by && !/^-?\d+(\.\d+)?$/.test(row.by)) return setError(`${row.by} isn't a number.`);
    }
    onSave({ ...row, label: row.label.trim() });
  }

  const toggle = <T,>(items: T[], item: T) => (items.includes(item) ? items.filter((entry) => entry !== item) : [...items, item]);
  const inScope = (account: Account) =>
    base === "profit_and_loss" ? account.accountClass === "revenue" || account.accountClass === "expense" : !["revenue", "expense"].includes(account.accountClass);

  return (
    <Card title={isNew ? `New ${kindName}` : `Change ${initial.label || kindName}`} description={table.title ? `In the table ${table.title}.` : undefined}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Name">
          <input value={row.label} maxLength={CUSTOM_REPORT_LIMITS.labelLength} onChange={(event) => setRow({ ...row, label: event.target.value })} autoFocus />
        </Field>
        {row.kind === "group" ? (
          <>
            <div className={ui.actions}>
              <label className={ui.checkbox}>
                <input type="radio" checked={!byCode} onChange={() => setByCode(false)} /> By account type
              </label>
              <label className={ui.checkbox}>
                <input type="radio" checked={byCode} onChange={() => setByCode(true)} /> Chosen accounts
              </label>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={row.showAccounts} onChange={(event) => setRow({ ...row, showAccounts: event.target.checked })} /> Show each account (otherwise just
                the total)
              </label>
            </div>
            {byCode ? (
              <div className={ui.choiceList}>
                {[...accounts]
                  .sort((a, b) => Number(inScope(b)) - Number(inScope(a)) || a.code.localeCompare(b.code))
                  .map((account) => (
                    <label key={account.id} className={ui.checkbox}>
                      <input
                        type="checkbox"
                        checked={row.accountCodes.includes(account.code)}
                        onChange={() =>
                          setRow({
                            ...row,
                            accountCodes: toggle(row.accountCodes, account.code),
                          })
                        }
                      />
                      {account.code} · {account.name}
                      {account.isActive ? "" : " (archived)"}
                    </label>
                  ))}
              </div>
            ) : (
              <div className={ui.choiceList}>
                {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((type) => (
                  <label key={type} className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={row.accountTypes.includes(type)}
                      onChange={() =>
                        setRow({
                          ...row,
                          accountTypes: toggle(row.accountTypes, type),
                        })
                      }
                    />
                    {ACCOUNT_TYPES[type].label}
                  </label>
                ))}
              </div>
            )}
            <p className={ui.muted}>
              Amounts are shown the way the standard reports show them: income as a plus, costs as a plus. To take one from the other, put them in separate groups and add a
              formula.
            </p>
          </>
        ) : null}
        {row.kind === "formula" ? (
          <Field label="Works out">
            <select
              value={row.operation ?? "sum"}
              onChange={(event) => {
                const operation = event.target.value as FormulaOperation;
                setRow(
                  operation === "sum"
                    ? {
                        id: row.id,
                        kind: "formula",
                        label: row.label,
                        terms: row.terms,
                      }
                    : {
                        id: row.id,
                        kind: "formula",
                        label: row.label,
                        terms: [],
                        operation,
                        a: row.a ?? others[0]?.id,
                        b: row.b ?? others[1]?.id ?? others[0]?.id,
                      },
                );
              }}
            >
              {(Object.keys(FORMULA_OPERATIONS) as FormulaOperation[]).map((operation) => (
                <option key={operation} value={operation}>
                  {FORMULA_OPERATIONS[operation]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {row.kind === "formula" && (row.operation ?? "sum") !== "sum" ? (
          <div className={ui.actions}>
            <select aria-label="First row" value={row.a ?? ""} onChange={(event) => setRow({ ...row, a: event.target.value })}>
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
            <span>{row.operation === "multiply" ? "×" : row.operation === "divide" ? "÷" : "% of"}</span>
            <select
              aria-label="Second row"
              value={row.by ? "" : (row.b ?? "")}
              onChange={(event) =>
                setRow({
                  ...row,
                  b: event.target.value || undefined,
                  by: event.target.value ? undefined : (row.by ?? "1"),
                })
              }
            >
              {row.operation !== "percent" ? <option value="">A number</option> : null}
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
            {row.operation !== "percent" && !row.b ? (
              <input aria-label="Number" inputMode="decimal" value={row.by ?? ""} onChange={(event) => setRow({ ...row, by: event.target.value })} style={{ maxWidth: 120 }} />
            ) : null}
            <InfoTip label="How it's worked out">
              In decimal maths. Money is rounded to the cent and a % to one decimal place, halves away from zero. Dividing by 0.00 shows a blank.
            </InfoTip>
          </div>
        ) : null}
        {row.kind === "formula" && (row.operation ?? "sum") === "sum" ? (
          <>
            {row.terms.length === 0 ? <p className={ui.muted}>No rows yet.</p> : null}
            {row.terms.map((term, index) => (
              <div key={index} className={ui.actions}>
                <select
                  aria-label="Add or subtract"
                  value={term.sign}
                  onChange={(event) => {
                    const terms = [...row.terms];
                    terms[index] = {
                      ...term,
                      sign: Number(event.target.value) as 1 | -1,
                    };
                    setRow({ ...row, terms });
                  }}
                >
                  <option value={1}>+ add</option>
                  <option value={-1}>− subtract</option>
                </select>
                <select
                  aria-label="Row"
                  value={term.rowId}
                  onChange={(event) => {
                    const terms = [...row.terms];
                    terms[index] = { ...term, rowId: event.target.value };
                    setRow({ ...row, terms });
                  }}
                >
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.label}
                    </option>
                  ))}
                </select>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    setRow({
                      ...row,
                      terms: row.terms.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {others.length > 0 ? (
              <div>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    setRow({
                      ...row,
                      terms: [...row.terms, { rowId: others[0].id, sign: 1 } satisfies FormulaTerm],
                    })
                  }
                >
                  Add a row to it
                </Button>
              </div>
            ) : (
              <p className={ui.muted}>This table has no other rows to add up yet.</p>
            )}
          </>
        ) : null}
        {row.kind === "earnings" ? (
          <Field label="Which earnings">
            <select
              value={row.which}
              onChange={(event) =>
                setRow({
                  ...row,
                  which: event.target.value as "previous" | "current",
                })
              }
            >
              <option value="current">Current year earnings</option>
              <option value="previous">Earnings from previous years</option>
            </select>
          </Field>
        ) : null}
        <div className={ui.actions}>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : isNew ? "Add row" : "Save row"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A row's text in a Notes column (LE7), saved when the box loses focus. */
export function NotesCellInput({ label, value, busy, onSave }: { label: string; value: string; busy: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Field label={`${label} column`}>
      <input
        value={text}
        disabled={busy}
        maxLength={CUSTOM_REPORT_LIMITS.cellLength}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() !== value) onSave(text.trim());
        }}
      />
    </Field>
  );
}

export function NoteBlock({ block, editable, busy, onSave }: { block: Extract<ComputedBlock, { kind: "text" }>; editable: boolean; busy: boolean; onSave: (text: string) => void }) {
  const [text, setText] = useState(block.text);
  if (!editable) return <p className={ui.reportNote}>{block.text}</p>;
  return (
    <>
      <textarea
        className={ui.noteInput}
        data-print="hide"
        aria-label="Note"
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        maxLength={CUSTOM_REPORT_LIMITS.noteLength}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() && text.trim() !== block.text) onSave(text.trim());
        }}
      />
      <p className={`${ui.reportNote} ${ui.printOnly}`}>{block.text}</p>
    </>
  );
}

export function NoteEditor({ row, busy, onSave, onCancel }: { row: ReportRow; busy: boolean; onSave: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(row.note ?? "");
  return (
    <Card title={`Note on ${row.label}`}>
      <Field label="Note">
        <textarea rows={3} maxLength={CUSTOM_REPORT_LIMITS.rowNoteLength} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      </Field>
      <div className={ui.actions}>
        <Button onClick={() => onSave(text.trim())} disabled={busy}>
          {text.trim() ? "Keep note" : "Remove note"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function SaveAsForm({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (title: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Card title="Save as a new report">
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <Field label="Name">
          <input value={name} maxLength={CUSTOM_REPORT_LIMITS.titleLength} onChange={(event) => setName(event.target.value)} autoFocus required />
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          Save as
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </Card>
  );
}
