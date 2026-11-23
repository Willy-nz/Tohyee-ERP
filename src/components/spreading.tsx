"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { dec, sum, toFixedString } from "@/lib/money/decimal";
import { addMonths, SPREAD_KIND_LABELS, SPREAD_KINDS, type SpreadKind, type SpreadMethod } from "@/lib/spreading/rules";
import type { MonthPreview } from "@/lib/spreading/runs";
import type { SpreadItem, SpreadWorksheet } from "@/lib/spreading/service";
import styles from "./spreading.module.css";

/**
 * Accounting › Spreading (examples SW1-SW14): what's been paid or billed
 * ahead of the months it belongs to, and what's been earned or used before
 * its bill or invoice. One tab a kind; each month posts as one journal after
 * a preview, and the tab says whether it matches its account in the ledger.
 */

const KIND_HELP: Record<SpreadKind, { what: string; code: string; example: string; arrived: string }> = {
  prepayment: {
    what: "A cost you've paid for ahead, like a year's insurance.",
    code: "Press Spread this on the bill, or code the bill to",
    example: "Insurance to June",
    arrived: "",
  },
  income_in_advance: {
    what: "Money you've invoiced or been paid before doing the work.",
    code: "Press Spread this on the invoice, or code the invoice to",
    example: "Year's subscription",
    arrived: "",
  },
  accrued_expense: {
    what: "A cost you've used but haven't had the bill for yet, like rates.",
    code: "When the bill comes, code it to",
    example: "Rates, July to September",
    arrived: "Bill arrived",
  },
  accrued_income: {
    what: "Work you've done but haven't invoiced yet.",
    code: "When you invoice it, code the invoice to",
    example: "Fencing job",
    arrived: "Invoice sent",
  },
};

const METHOD_CHOICES: Array<{ value: SpreadMethod; label: string }> = [
  { value: "by_month", label: "Evenly by month" },
  { value: "by_days", label: "By days" },
  { value: "one_month", label: "All in one month" },
  { value: "own_amounts", label: "My own amounts" },
  { value: "when_done", label: "When it's done" },
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shortMonth(month: string): string {
  return `${SHORT_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;
}

function longMonth(month: string): string {
  return `${LONG_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function total(amounts: string[]): string {
  return toFixedString(sum(amounts.map((amount) => dec(amount))), 2);
}

function isAccrual(kind: SpreadKind): boolean {
  return kind === "accrued_expense" || kind === "accrued_income";
}

/** The month to post next for a kind: its earliest waiting month, or the one after the last posted, or this month. */
function nextMonth(worksheet: SpreadWorksheet, kind: SpreadKind): string {
  const waiting = worksheet.items
    .filter((item) => item.kind === kind)
    .flatMap((item) => item.months.filter((row) => row.runId === null).map((row) => row.month))
    .sort();
  if (waiting[0]) return waiting[0];
  const latest = worksheet.posted[kind]?.month;
  return latest ? addMonths(latest, 1) : todayInBrowser().slice(0, 7);
}

function statusOf(item: SpreadItem): { label: string; tone: "green" | "neutral" | "amber" | "blue" } {
  if (item.waiting) return { label: "Waiting till it's done", tone: "amber" };
  if (item.finished) return { label: "Finished", tone: "neutral" };
  if (isAccrual(item.kind) && !item.settledMonth && !item.months.some((row) => row.runId === null)) {
    return { label: item.kind === "accrued_expense" ? "Waiting for its bill" : "Waiting to be invoiced", tone: "amber" };
  }
  return { label: "Spreading", tone: "green" };
}

export function Spreading({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [kind, setKind] = useState<SpreadKind>("prepayment");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheet = useApiData<{ worksheet: SpreadWorksheet }>("/api/spreading", { organisationId });
  const worksheet = sheet.data?.worksheet ?? null;

  async function send(method: "POST" | "PUT" | "DELETE", path: string, body: Record<string, unknown> | null, text: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      // A request with no body (removing an item) says which organisation in its address.
      if (body) await api(path, { method, body: { organisationId, source: "ui", ...body } });
      else await api(`${path}?organisationId=${encodeURIComponent(organisationId)}`, { method });
      setMessage(text);
      sheet.reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (sheet.error) return <Notice tone="error">{sheet.error}</Notice>;
  if (!worksheet) return <p className={ui.muted}>Loading…</p>;

  if (!worksheet.ready) {
    return (
      <>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Card title="Spread income and costs over the months they belong to">
          <div className={ui.stack}>
            <p>Instead of a spreadsheet. Add something once, check each month&apos;s amounts, and press Post. Nothing posts by itself.</p>
            <ul className={styles.kinds}>
              {SPREAD_KINDS.map((each) => (
                <li key={each}>
                  <strong>{SPREAD_KIND_LABELS[each]}.</strong> {KIND_HELP[each].what}
                </li>
              ))}
            </ul>
            {can("admin") ? (
              <div>
                <Button disabled={busy} onClick={() => void send("PUT", "/api/spreading/settings", {}, "Spreading is on.")}>
                  Turn on Spreading
                </Button>
                <p className={ui.muted}>Uses 1200 Prepayments, and adds Accrued income, Income in advance and Accrued expenses if they aren&apos;t there.</p>
              </div>
            ) : (
              <Notice>An admin needs to turn this on.</Notice>
            )}
          </div>
        </Card>
      </>
    );
  }

  const items = worksheet.items.filter((item) => item.kind === kind);
  const tie = worksheet.tieOut.find((row) => row.kind === kind)!;
  const matches = Number(tie.difference) === 0;

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tabs} role="tablist" aria-label="Kinds">
        {SPREAD_KINDS.map((each) => {
          const open = worksheet.items.filter((item) => item.kind === each && !item.finished).length;
          return (
            <button key={each} type="button" role="tab" aria-selected={kind === each} className={`${ui.tab} ${kind === each ? ui.tabActive : ""}`} onClick={() => setKind(each)}>
              {SPREAD_KIND_LABELS[each]}
              {open > 0 ? <span className={ui.tabCount}> {open}</span> : null}
            </button>
          );
        })}
      </div>

      <div className={styles.tie}>
        <span>
          {KIND_HELP[kind].what} {KIND_HELP[kind].code}{" "}
          <strong>
            {tie.account?.code} {tie.account?.name}
          </strong>
          .
        </span>
        <span className={styles.tieResult}>
          {matches ? <Badge tone="green">Matches the ledger</Badge> : <Badge tone="red">Out by {tie.difference.replace("-", "")}</Badge>}
          <InfoTip label="What this checks">
            The worksheet holds <Money value={tie.worksheet} /> and the account holds <Money value={tie.ledger} />. When they differ, something was coded to the account that isn&apos;t on
            the worksheet, or the other way round.
          </InfoTip>
        </span>
      </div>

      <MonthEnd key={`${kind}:${nextMonth(worksheet, kind)}:${worksheet.posted[kind]?.runId ?? ""}`} organisationId={organisationId} kind={kind} worksheet={worksheet} busy={busy} send={send} />

      <Card title={SPREAD_KIND_LABELS[kind]}>
        {items.length === 0 ? <Empty picture="calendar">Nothing here yet.</Empty> : <ItemsGrid items={items} kind={kind} busy={busy} send={send} canEdit={can("bookkeeper")} />}
      </Card>

      {can("bookkeeper") ? <AddItem key={kind} organisationId={organisationId} kind={kind} busy={busy} send={send} /> : null}
    </>
  );
}

type Send = (method: "POST" | "PUT" | "DELETE", path: string, body: Record<string, unknown> | null, text: string) => Promise<boolean>;

function MonthEnd({ organisationId, kind, worksheet, busy, send }: { organisationId: string; kind: SpreadKind; worksheet: SpreadWorksheet; busy: boolean; send: Send }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const [month, setMonth] = useState(() => nextMonth(worksheet, kind));
  const [postKey, setPostKey] = useState(() => newIdempotencyKey("spread"));
  const [showJournal, setShowJournal] = useState(false);
  const preview = useApiData<{ preview: MonthPreview }>(/^\d{4}-\d{2}$/.test(month) ? "/api/spreading" : null, { organisationId, kind, month });
  const data = preview.data?.preview ?? null;
  const latest = worksheet.posted[kind];

  return (
    <Card title="Month end" description="One journal for the month, dated its last day. Check it, then post.">
      <div className={ui.inlineForm}>
        <Field label="Month" hint={latest ? `Posted to ${longMonth(latest.month)}.` : "Nothing posted yet."}>
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </Field>
        {can("bookkeeper") && data && !data.runId ? (
          <Button
            disabled={busy || Boolean(data.blocked)}
            onClick={() =>
              void send("POST", "/api/spreading/months", { idempotencyKey: postKey, kind, month }, `${SPREAD_KIND_LABELS[kind]} posted for ${longMonth(month)}.`).then(() =>
                setPostKey(newIdempotencyKey("spread")),
              )
            }
          >
            Post {longMonth(month)}
          </Button>
        ) : null}
        {can("bookkeeper") && latest ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              if (!(await confirm(`Undo ${longMonth(latest.month)}? Its journal is reversed on the same date, and the amounts wait to be posted again.`))) return;
              void send("POST", `/api/spreading/runs/${latest.runId}/undo`, { idempotencyKey: newIdempotencyKey("undo") }, `${longMonth(latest.month)} undone.`);
            }}
          >
            Undo {longMonth(latest.month)}
          </Button>
        ) : null}
      </div>
      {preview.error ? <Notice tone="warning">{preview.error}</Notice> : null}
      {data?.blocked ? <Notice tone="warning">{data.blocked}</Notice> : null}
      {data?.runId ? <Notice tone="success">{longMonth(month)} is posted.</Notice> : null}
      {data && data.rows.length === 0 && !data.runId && !data.blocked ? <p className={ui.muted}>Nothing to post for {longMonth(month)}. Posting it just marks the month done.</p> : null}
      {data && data.rows.length > 0 ? (
        <>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>What</th>
                  <th>To</th>
                  <th className={ui.num}>{longMonth(month)}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={index}>
                    <td data-label="What">
                      {row.description}
                      {row.lineKind === "difference" ? <span className={ui.muted}> · over or under what was accrued</span> : null}
                    </td>
                    <td data-label="To">
                      {row.targetCode} {row.targetName}
                    </td>
                    <td data-label={longMonth(month)} className={ui.num}>
                      <Money value={row.amount} />
                    </td>
                  </tr>
                ))}
                <tr className={ui.reportTotal}>
                  <td colSpan={2}>Total</td>
                  <td className={ui.num}>
                    <Money value={data.total} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <button type="button" className={styles.linkButton} aria-expanded={showJournal} onClick={() => setShowJournal(!showJournal)}>
            {showJournal ? "Hide the journal" : "Show the journal"}
          </button>
          {showJournal ? (
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Description</th>
                    <th className={ui.num}>Debit</th>
                    <th className={ui.num}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.journalLines.map((line, index) => (
                    <tr key={index}>
                      <td data-label="Account">{line.accountCode}</td>
                      <td data-label="Description">{line.description}</td>
                      <td data-label="Debit" className={ui.num}>
                        <Money value={line.debitAmount} blankZero />
                      </td>
                      <td data-label="Credit" className={ui.num}>
                        <Money value={line.creditAmount} blankZero />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      {latest?.journalId ? (
        <p className={ui.muted}>
          Last journal: <Link href={`/operations/ledger-journals?journal=${latest.journalId}`}>{longMonth(latest.month)}</Link>
        </p>
      ) : null}
    </Card>
  );
}

/** The spreadsheet view: a row an item, a column a month. Posted months are ticked. */
function ItemsGrid({ items, kind, busy, send, canEdit }: { items: SpreadItem[]; kind: SpreadKind; busy: boolean; send: Send; canEdit: boolean }) {
  const confirm = useConfirm();
  const [acting, setActing] = useState<{ id: string; action: "end" | "done" | "settle" } | null>(null);
  const [actMonth, setActMonth] = useState(todayInBrowser().slice(0, 7));
  const [actAmount, setActAmount] = useState("");
  const [showFinished, setShowFinished] = useState(false);
  const shown = items.filter((item) => showFinished || !item.finished);
  const finished = items.length - items.filter((item) => !item.finished).length;
  const months = useMemo(() => {
    const all = new Set<string>();
    for (const item of shown) for (const row of item.months) all.add(row.month);
    return [...all].sort();
  }, [shown]);
  const amountIn = (item: SpreadItem, month: string) => item.months.filter((row) => row.month === month);

  async function act(item: SpreadItem) {
    if (!acting) return;
    const path = `/api/spreading/items/${item.id}/${acting.action === "end" ? "end-early" : acting.action}`;
    const body = acting.action === "settle" ? { month: actMonth, amount: actAmount } : { month: actMonth };
    const text = acting.action === "end" ? `The rest of ${item.description} now lands in ${longMonth(actMonth)}.` : acting.action === "done" ? `${item.description} lands in ${longMonth(actMonth)}.` : `${item.description} marked at ${actAmount}.`;
    if (await send("POST", path, body, text)) setActing(null);
  }

  return (
    <>
      {shown.length === 0 ? <p className={ui.muted}>Everything here is finished.</p> : null}
      {shown.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${styles.grid}`}>
            <thead>
              <tr>
                <th className={styles.sticky}>What</th>
                <th className={ui.num}>Amount</th>
                <th className={ui.num}>
                  {isAccrual(kind) ? "Accrued" : "Left"}
                </th>
                {months.map((month) => (
                  <th key={month} className={ui.num}>
                    {shortMonth(month)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const status = statusOf(item);
                const open = acting?.id === item.id;
                const canEnd = !isAccrual(kind) && !item.waiting && item.months.some((row) => row.runId === null);
                const canSettle = isAccrual(kind) && !item.settledMonth;
                const canRemove = !item.months.some((row) => row.runId !== null);
                return (
                  <tr key={item.id}>
                    <td className={styles.sticky}>
                      <div>{item.description}</div>
                      <div className={ui.muted}>
                        {item.target.code} {item.target.name}
                      </div>
                      {item.source ? (
                        <div>
                          <Link href={`/operations/${item.source.kind === "bill" ? "bills" : "invoices"}/${item.source.documentId}`}>{item.source.label}</Link>
                        </div>
                      ) : null}
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {canEdit && !open ? (
                        <div className={styles.rowActions}>
                          {item.waiting ? (
                            <Button size="small" variant="secondary" disabled={busy} onClick={() => setActing({ id: item.id, action: "done" })}>
                              Mark done
                            </Button>
                          ) : null}
                          {canSettle ? (
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => {
                                setActAmount(item.amount);
                                setActing({ id: item.id, action: "settle" });
                              }}
                            >
                              {KIND_HELP[kind].arrived}
                            </Button>
                          ) : null}
                          {canEnd ? (
                            <Button size="small" variant="secondary" disabled={busy} onClick={() => setActing({ id: item.id, action: "end" })}>
                              End early
                            </Button>
                          ) : null}
                          {canRemove ? (
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={busy}
                              onClick={async () => {
                                if (!(await confirm(`Remove ${item.description}? Nothing has posted for it.`))) return;
                                void send("DELETE", `/api/spreading/items/${item.id}`, null, `${item.description} removed.`);
                              }}
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {open ? (
                        <div className={styles.rowForm}>
                          <label>
                            {acting.action === "end" ? "Release the rest in" : acting.action === "done" ? "Done in" : KIND_HELP[kind].arrived + " in"}
                            <input type="month" value={actMonth} onChange={(event) => setActMonth(event.target.value)} />
                          </label>
                          {acting.action === "settle" ? (
                            <label>
                              It came to (without GST)
                              <input inputMode="decimal" value={actAmount} onChange={(event) => setActAmount(event.target.value)} />
                            </label>
                          ) : null}
                          <div className={styles.rowActions}>
                            <Button size="small" disabled={busy} onClick={() => void act(item)}>
                              Save
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => setActing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </td>
                    <td className={ui.num}>
                      <Money value={item.amount} />
                      {item.settledAmount ? (
                        <div className={ui.muted}>
                          came to <Money value={item.settledAmount} />
                        </div>
                      ) : null}
                    </td>
                    <td className={ui.num}>
                      <Money value={item.left} />
                    </td>
                    {months.map((month) => {
                      const rows = amountIn(item, month);
                      return (
                        <td key={month} className={`${ui.num} ${rows.length > 0 && rows.every((row) => row.runId) ? styles.posted : ""}`}>
                          {rows.map((row) => (
                            <div key={row.lineKind} title={row.runId ? "Posted" : "Not posted yet"}>
                              <Money value={row.amount} />
                              {row.runId ? <span aria-label="posted"> ✓</span> : null}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {shown.length > 1 ? (
                <tr className={ui.reportTotal}>
                  <td className={styles.sticky}>Total</td>
                  <td />
                  <td className={ui.num}>
                    <Money value={total(shown.map((item) => item.left))} />
                  </td>
                  {months.map((month) => (
                    <td key={month} className={ui.num}>
                      <Money value={total(shown.flatMap((item) => amountIn(item, month).map((row) => row.amount)))} />
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      {finished > 0 ? (
        <button type="button" className={styles.linkButton} onClick={() => setShowFinished(!showFinished)}>
          {showFinished ? "Hide finished" : `Show ${finished} finished`}
        </button>
      ) : null}
    </>
  );
}

function AddItem({ organisationId, kind, busy, send }: { organisationId: string; kind: SpreadKind; busy: boolean; send: Send }) {
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
  const wanted = kind === "prepayment" || kind === "accrued_expense" ? "expense" : "revenue";
  const dated = method === "by_month" || method === "by_days";

  if (!open) {
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Add {SPREAD_KIND_LABELS[kind].toLowerCase()}</Button>
      </div>
    );
  }

  async function save() {
    const body: Record<string, unknown> = { idempotencyKey: itemKey, kind, description, amount, targetAccountCode: target, method };
    if (dated) Object.assign(body, { startDate, endDate });
    if (method === "one_month") body.month = month;
    if (method === "own_amounts") body.ownAmounts = own.filter((row) => row.amount.trim() !== "");
    if (await send("POST", "/api/spreading/items", body, `${description} added.`)) {
      setItemKey(newIdempotencyKey("item"));
      setDescription("");
      setAmount("");
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
