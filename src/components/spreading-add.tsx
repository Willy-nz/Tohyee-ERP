"use client";

import { useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { addMonths, SPREAD_KIND_LABELS, type SpreadKind, type SpreadMethod } from "@/lib/spreading/rules";
import { downloadFile, isAccrual, KIND_HELP, METHOD_CHOICES, type Send } from "./spreading-shared";
import { ItemTagInputs, type ItemTags, useTagSetups } from "./spreading-tags";
import styles from "./spreading.module.css";

/** Adding an item to the Spreading worksheet by hand, or bringing a file of them in (examples SW1-SW7, SW12, SW13, SW23, SW25). */

export function AddItem({ organisationId, kind, busy, send, onImported }: { organisationId: string; kind: SpreadKind; busy: boolean; send: Send; onImported: (text: string) => void }) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importKey, setImportKey] = useState(() => newIdempotencyKey("import"));

  async function bringIn(file: File) {
    setImportError(null);
    try {
      const csv = await file.text();
      const done = await api<{ added: number }>("/api/spreading/import", { method: "POST", body: { organisationId, idempotencyKey: importKey, csv } });
      setImportKey(newIdempotencyKey("import"));
      setImporting(false);
      onImported(`${done.added} ${done.added === 1 ? "item" : "items"} brought in.`);
    } catch (caught) {
      setImportError(errorMessage(caught));
    }
  }

  const accounts = useAccounts(organisationId);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [target, setTarget] = useState("");
  const [method, setMethod] = useState<SpreadMethod>("by_month");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [month, setMonth] = useState(todayInBrowser().slice(0, 7));
  const [own, setOwn] = useState<Array<{ month: string; amount: string }>>([{ month: todayInBrowser().slice(0, 7), amount: "" }]);
  const [itemKey, setItemKey] = useState(() => newIdempotencyKey("item"));
  const setups = useTagSetups(organisationId);
  const [tags, setTags] = useState<ItemTags>({ tracking: {}, customFields: {} });
  const wanted = kind === "prepayment" || kind === "accrued_expense" ? "expense" : "revenue";
  const dated = method === "by_month" || method === "by_days";

  if (!open) {
    return (
      <div className={ui.stack}>
        <div className={styles.rowActions}>
          <Button onClick={() => setOpen(true)}>Add {SPREAD_KIND_LABELS[kind].toLowerCase()}</Button>
          <Button variant="secondary" onClick={() => setImporting(!importing)}>
            Bring in from a file
          </Button>
        </div>
        {importing ? (
          <Card title="Bring in from a file" description="A CSV file with a row for each item, any of the four kinds. All of them are added, or none if a row has a problem.">
            {importError ? <Notice tone="error">{importError}</Notice> : null}
            <div className={ui.stack}>
              <button type="button" className={styles.linkButton} onClick={() => void downloadFile(organisationId, { what: "template" }, "spreading-import.csv").catch((caught) => setImportError(errorMessage(caught)))}>
                Download a file to fill in
              </button>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void bringIn(file);
                  event.target.value = "";
                }}
              />
            </div>
          </Card>
        ) : null}
      </div>
    );
  }

  async function save() {
    const body: Record<string, unknown> = { idempotencyKey: itemKey, kind, description, amount, targetAccountCode: target, method };
    if (dated) Object.assign(body, { startDate, endDate });
    if (method === "one_month") body.month = month;
    if (method === "own_amounts") body.ownAmounts = own.filter((row) => row.amount.trim() !== "");
    if (Object.keys(tags.tracking).length > 0) body.tracking = tags.tracking;
    if (Object.keys(tags.customFields).length > 0) body.customFields = tags.customFields;
    if (await send("POST", "/api/spreading/items", body, `${description} added.`)) {
      setItemKey(newIdempotencyKey("item"));
      setDescription("");
      setAmount("");
      setTags({ tracking: {}, customFields: {} });
      setOpen(false);
    }
  }

  return (
    <Card title={`Add ${SPREAD_KIND_LABELS[kind].toLowerCase()}`}>
      <div className={styles.form}>
        <Field label="What is it">
          <input value={description} maxLength={200} placeholder={KIND_HELP[kind].example} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="Amount" hint={isAccrual(kind) ? "Your best estimate, without GST." : "Without GST if you're GST registered: the amount that went to the account."}>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label={wanted === "expense" ? "Expense account" : "Income account"}>
          <AccountSelect accounts={accounts.data?.accounts ?? []} value={target} onChange={setTarget} filter={(account) => account.accountClass === wanted} />
        </Field>
        <Field label="How to spread it">
          <select value={method} onChange={(event) => setMethod(event.target.value as SpreadMethod)}>
            {METHOD_CHOICES.filter((choice) => !(isAccrual(kind) && choice.value === "when_done")).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
        {dated ? (
          <>
            <Field label="Covers from">
              <DateInput value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </Field>
            <Field label="To">
              <DateInput value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </Field>
          </>
        ) : null}
        {method === "one_month" ? (
          <Field label="Month">
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </Field>
        ) : null}
        {method === "when_done" ? <p className={ui.muted}>It sits in the account until you mark it done. Then all of it lands in that month.</p> : null}
        <ItemTagInputs setups={setups} value={tags} onChange={setTags} disabled={busy} />
      </div>
      {method === "own_amounts" ? (
        <div className={styles.own}>
          {own.map((row, index) => (
            <div key={index} className={styles.ownRow}>
              <input aria-label="Month" type="month" value={row.month} onChange={(event) => setOwn(own.map((each, at) => (at === index ? { ...each, month: event.target.value } : each)))} />
              <input aria-label="Amount" inputMode="decimal" placeholder="0.00" value={row.amount} onChange={(event) => setOwn(own.map((each, at) => (at === index ? { ...each, amount: event.target.value } : each)))} />
            </div>
          ))}
          <button type="button" className={styles.linkButton} onClick={() => setOwn([...own, { month: addMonths(own[own.length - 1].month, 1), amount: "" }])}>
            Add a month
          </button>
        </div>
      ) : null}
      <div className={styles.rowActions}>
        <Button disabled={busy || !description.trim() || !amount.trim() || !target} onClick={() => void save()}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
