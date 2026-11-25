"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { caughtUpText } from "@/components/spread-this";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import { dec, sum, toFixedString } from "@/lib/money/decimal";
import type { CustomValues } from "@/lib/custom-fields/values";
import { addMonths, SPREAD_KIND_LABELS, SPREAD_KINDS, type SpreadKind } from "@/lib/spreading/rules";
import type { SpreadExplain } from "@/lib/spreading/explain";
import type { MonthPreview } from "@/lib/spreading/runs";
import type { SpreadItem, SpreadWorksheet } from "@/lib/spreading/service";
import { AddItem } from "./spreading-add";
import { SpreadingSuggestions } from "./spreading-suggestions";
import { downloadFile, isAccrual, KIND_HELP, type Send } from "./spreading-shared";
import { ItemTagInputs, ItemTagsText, type TagSetups, useTagSetups } from "./spreading-tags";
import styles from "./spreading.module.css";

/**
 * Accounting › Spreading (examples SW1-SW14): what's been paid or billed
 * ahead of the months it belongs to, and what's been earned or used before
 * its bill or invoice. One tab a kind; each month posts as one journal after
 * a preview, and the tab says whether it matches its account in the ledger.
 */

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
  const setups = useTagSetups(organisationId);
  const worksheet = sheet.data?.worksheet ?? null;

  async function send(method: "POST" | "PUT" | "DELETE", path: string, body: Record<string, unknown> | null, text: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      // A request with no body (removing an item) says which organisation in its address.
      let caughtUp: Parameters<typeof caughtUpText>[0] = null;
      if (body) caughtUp = (await api<{ caughtUp?: Parameters<typeof caughtUpText>[0] }>(path, { method, body: { organisationId, source: "ui", ...body } }))?.caughtUp ?? null;
      else await api(`${path}?organisationId=${encodeURIComponent(organisationId)}`, { method });
      setMessage(`${text}${caughtUpText(caughtUp)}`);
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
      <SpreadingSuggestions organisationId={organisationId} canEdit={can("bookkeeper")} busy={busy} send={send} />
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
        {worksheet.booksElsewhere ? (
          <span>
            {KIND_HELP[kind].what} The worksheet holds{" "}
            <strong>
              <Money value={tie.worksheet} />
            </strong>
            : compare it with {tie.account?.code} {tie.account?.name} in your other software.
          </span>
        ) : (
          <>
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
                The worksheet holds <Money value={tie.worksheet} /> and the account holds <Money value={tie.ledger} />. When they differ, something was coded to the account that
                isn&apos;t on the worksheet, or the other way round.
              </InfoTip>
            </span>
          </>
        )}
      </div>

      {!matches && !worksheet.booksElsewhere ? <Behind key={`${kind}:${tie.difference}`} organisationId={organisationId} kind={kind} /> : null}

      <MonthEnd key={`${kind}:${nextMonth(worksheet, kind)}:${worksheet.posted[kind]?.runId ?? ""}`} organisationId={organisationId} kind={kind} worksheet={worksheet} busy={busy} send={send} />

      <Card title={SPREAD_KIND_LABELS[kind]}>
        {items.length === 0 ? <Empty picture="calendar">Nothing here yet.</Empty> : <ItemsGrid items={items} kind={kind} busy={busy} send={send} canEdit={can("bookkeeper")} setups={setups} />}
        {kind === "income_in_advance"
          ? worksheet.shopHeld.map((row) => (
              <p key={row.account.id} className={styles.shopHeld}>
                <span>
                  Shop orders paid and not sent yet: <Money value={row.held} />. <Link href="/operations/to-send">To send</Link>
                </span>
                <span className={ui.muted}>
                  {row.counted ? "They release when they're sent, and are counted in the check above." : `Held in ${row.account.code} ${row.account.name}, so not counted here.`}
                </span>
              </p>
            ))
          : null}
        {items.length > 0 ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void downloadFile(organisationId, { what: "worksheet", kind }, `spreading-${kind}.csv`).catch((caught) => setError(errorMessage(caught)))}
          >
            Download as a file
          </button>
        ) : null}
      </Card>

      {can("bookkeeper") ? <AddItem key={kind} organisationId={organisationId} kind={kind} busy={busy} send={send} onImported={(text) => { setMessage(text); sheet.reload(); }} /> : null}
      {can("admin") ? (
        <label className={styles.setting}>
          <input
            type="checkbox"
            checked={worksheet.booksElsewhere}
            disabled={busy}
            onChange={(event) =>
              void send("PUT", "/api/spreading/settings", { booksElsewhere: event.target.checked }, event.target.checked ? "The worksheet now runs on its own. Download each month's journal to enter in your other software." : "The worksheet is checked against the ledger again.")
            }
          />
          <span>
            Our books are kept in other software
            <span className={ui.muted}> · the worksheet runs on its own, and each month&apos;s journal is downloaded as a file</span>
          </span>
        </label>
      ) : null}
    </>
  );
}

/** The two lists to match by eye when a tab is out (SW24). */
function Behind({ organisationId, kind }: { organisationId: string; kind: SpreadKind }) {
  const [open, setOpen] = useState(false);
  const found = useApiData<{ explain: SpreadExplain }>(open ? "/api/spreading" : null, { organisationId, kind, explain: "1" });
  const explain = found.data?.explain ?? null;
  return (
    <div className={styles.behind}>
      <button type="button" className={styles.linkButton} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide what's behind it" : "See what's behind it"}
      </button>
      {open && found.error ? <Notice tone="error">{found.error}</Notice> : null}
      {open && explain ? (
        <Card title="What's behind it" description="Match the two lists. Whatever has no partner is the difference.">
          <div className={styles.behindLists}>
            <div>
              <h3>
                Coded to {explain.account.code} from outside the worksheet · <Money value={explain.outsideTotal} />
              </h3>
              {explain.outside.length === 0 ? <p className={ui.muted}>Nothing.</p> : null}
              <ul className={styles.behindList}>
                {explain.outside.map((row) => (
                  <li key={row.journalId}>
                    <span>
                      <Link href={`/operations/ledger-journals?journal=${row.journalId}`}>{row.reference}</Link> · {formatDate(row.date)}
                      {row.description ? <span className={ui.muted}> · {row.description}</span> : null}
                    </span>
                    <Money value={row.amount} />
                  </li>
                ))}
              </ul>
              {explain.outsideMore > 0 ? <p className={ui.muted}>And {explain.outsideMore} older ones, counted in the total.</p> : null}
            </div>
            <div>
              <h3>
                What the worksheet expects there · <Money value={explain.expectedTotal} />
              </h3>
              {explain.expected.length === 0 ? <p className={ui.muted}>Nothing.</p> : null}
              <ul className={styles.behindList}>
                {explain.expected.map((row, index) => (
                  <li key={index}>
                    <span>{row.description}</span>
                    <Money value={row.amount} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className={ui.muted}>Things added with Spread this aren&apos;t listed: they bring their own entry. Voided entries are left off.</p>
        </Card>
      ) : null}
    </div>
  );
}


function MonthEnd({ organisationId, kind, worksheet, busy, send }: { organisationId: string; kind: SpreadKind; worksheet: SpreadWorksheet; busy: boolean; send: Send }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const [month, setMonth] = useState(() => nextMonth(worksheet, kind));
  const [postKey, setPostKey] = useState(() => newIdempotencyKey("spread"));
  const [showJournal, setShowJournal] = useState(false);
  // The journal's own custom fields (SW25), with their defaults until something is typed.
  const customSetup = useCustomFields(organisationId);
  const [journalFields, setJournalFields] = useState<CustomValues | undefined>(undefined);
  const journalValues = journalFields ?? startingValues(customSetup.data, "document", ["journal"]);
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
              void send("POST", "/api/spreading/months", { idempotencyKey: postKey, kind, month, customFields: journalValues }, `${SPREAD_KIND_LABELS[kind]} posted for ${longMonth(month)}.`).then(() =>
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
      {can("bookkeeper") && data && !data.runId && data.rows.length > 0 ? (
        <CustomFieldInputs setup={customSetup.data} record="document" uses={["journal"]} value={journalValues} onChange={setJournalFields} disabled={busy} />
      ) : null}
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
          <div className={styles.rowActions}>
            <button type="button" className={styles.linkButton} aria-expanded={showJournal} onClick={() => setShowJournal(!showJournal)}>
              {showJournal ? "Hide the journal" : "Show the journal"}
            </button>
            <button type="button" className={styles.linkButton} onClick={() => void downloadFile(organisationId, { what: "journal", kind, month }, `spreading-${kind}-${month}.csv`).catch(() => undefined)}>
              Download the journal
            </button>
          </div>
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

/** What an item's months not yet posted add up to. */
function stillToCome(item: SpreadItem): string {
  return toFixedString(sum(item.months.filter((row) => row.runId === null && row.lineKind === "share").map((row) => dec(row.amount))), 2);
}

/** The spreadsheet view: a row an item, a column a month. Posted months are ticked. */
function ItemsGrid({ items, kind, busy, send, canEdit, setups }: { items: SpreadItem[]; kind: SpreadKind; busy: boolean; send: Send; canEdit: boolean; setups: TagSetups }) {
  const [tagging, setTagging] = useState<{ id: string; tracking: SpreadItem["tracking"]; customFields: SpreadItem["customFields"] } | null>(null);
  const confirm = useConfirm();
  const [acting, setActing] = useState<{ id: string; action: "end" | "done" | "settle" | "change" } | null>(null);
  const [actEnd, setActEnd] = useState("");
  const [actLeft, setActLeft] = useState("");
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
    if (acting.action === "change") {
      // Only what was changed is sent: a new last day, and for an accrual a new amount still to come.
      const body: Record<string, unknown> = {};
      if (actEnd && actEnd !== item.endDate) body.endDate = actEnd;
      if (isAccrual(kind) && actLeft.trim() && actLeft.trim() !== stillToCome(item)) body.left = actLeft.trim();
      if (await send("POST", `/api/spreading/items/${item.id}/change`, body, `${item.description}: the months still to come are spread again.`)) setActing(null);
      return;
    }
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
                const canChange = (item.method === "by_month" || item.method === "by_days") && !item.settledMonth && item.months.some((row) => row.runId === null);
                const canRemove = !item.months.some((row) => row.runId !== null);
                return (
                  <tr key={item.id}>
                    <td className={styles.sticky}>
                      <div>{item.description}</div>
                      <div className={ui.muted}>
                        {item.target.code} {item.target.name}
                      </div>
                      <ItemTagsText setups={setups} value={item} />
                      {item.source ? (
                        <div>
                          <Link href={`/operations/${item.source.kind === "bill" ? "bills" : item.source.kind === "invoice" ? "invoices" : "bank-transactions"}/${item.source.documentId}`}>{item.source.label}</Link>
                        </div>
                      ) : null}
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {canEdit && !open && tagging?.id !== item.id ? (
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
                          {canChange ? (
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => {
                                setActEnd(item.endDate ?? "");
                                setActLeft(stillToCome(item));
                                setActing({ id: item.id, action: "change" });
                              }}
                            >
                              Change
                            </Button>
                          ) : null}
                          {setups.any && !item.finished ? (
                            <Button size="small" variant="secondary" disabled={busy} onClick={() => setTagging({ id: item.id, tracking: item.tracking, customFields: item.customFields })}>
                              Tracking
                            </Button>
                          ) : null}
                          {item.canUnsettle ? (
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={busy}
                              onClick={async () => {
                                if (!(await confirm(`Undo "${KIND_HELP[kind].arrived.toLowerCase()}" for ${item.description}? It goes back to waiting.`))) return;
                                void send("POST", `/api/spreading/items/${item.id}/unsettle`, {}, `${item.description} is waiting again.`);
                              }}
                            >
                              Undo {KIND_HELP[kind].arrived.toLowerCase()}
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
                      {tagging?.id === item.id ? (
                        <div className={styles.rowForm}>
                          <ItemTagInputs setups={setups} value={tagging} onChange={(next) => setTagging({ id: item.id, ...next })} disabled={busy} />
                          <div className={styles.rowActions}>
                            <Button
                              size="small"
                              disabled={busy}
                              onClick={async () => {
                                if (await send("PUT", `/api/spreading/items/${item.id}`, { tracking: tagging.tracking, customFields: tagging.customFields }, `${item.description} updated for the months not yet posted.`)) setTagging(null);
                              }}
                            >
                              Save
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => setTagging(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {open && acting.action === "change" ? (
                        <div className={styles.rowForm}>
                          <label>
                            New last day
                            <DateInput value={actEnd} onChange={(event) => setActEnd(event.target.value)} />
                          </label>
                          {isAccrual(kind) ? (
                            <label>
                              Still to come (without GST)
                              <input inputMode="decimal" value={actLeft} onChange={(event) => setActLeft(event.target.value)} />
                            </label>
                          ) : null}
                          <p className={ui.muted}>Months already posted stay as they are. What&apos;s left is spread again over the months still to come.</p>
                          <div className={styles.rowActions}>
                            <Button size="small" disabled={busy || (actEnd === (item.endDate ?? "") && (!isAccrual(kind) || actLeft.trim() === stillToCome(item)))} onClick={() => void act(item)}>
                              Save
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => setActing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {open && acting.action !== "change" ? (
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
