"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button,Card,Field,Notice,Stat,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { ValuationPreview } from "@/lib/livestock/valuation";
import { NotOn,Steps,YearPicker,defaultYear,useLivestockSettings,yearEnds } from "@/components/livestock/shared";

// Valuation ------------------------------------------------------------------------

export function LivestockValuation({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useLivestockSettings(organisationId);
  const [chosen, setChosen] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;
  const years = yearEnds(settings.data.settings);
  const yearEnd = chosen ?? defaultYear(years);
  return (
    <>
      <Steps current="valuation" />
      <div className={ui.toolbar}>
        <YearPicker years={years} value={yearEnd} onChange={setChosen} />
      </div>
      <ValuationView key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} />
    </>
  );
}

function ValuationView({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const preview = useApiData<{ valuation: ValuationPreview }>("/api/livestock/valuation", { organisationId, yearEnd });
  const [key, setKey] = useState(() => newIdempotencyKey("lvv"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (preview.error) return <Notice tone="error">{preview.error}</Notice>;
  if (!preview.data) return <p className={ui.muted}>Loading…</p>;
  const { workings, journal, problems, notices, approved, revaluationTarget } = preview.data.valuation;
  const totals = workings.totals;

  async function approve() {
    const ok = await confirm(`Approve the livestock valuation for the year to ${formatDate(yearEnd)} and post its journal?`, { confirmLabel: "Approve and post" });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/valuation", { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, yearEnd } });
      setKey(newIdempotencyKey("lvv"));
      preview.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function replace() {
    const ok = await confirm("Replace this valuation? Its journal is reversed, and the year can be changed and approved again.", { confirmLabel: "Replace", danger: true });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/valuation/replace", { method: "POST", body: { organisationId, yearEnd, reason } });
      setReason("");
      preview.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {approved ? (
        <Notice tone="success">
          Approved by {approved.approvedByEmail} on {formatDate(approved.approvedAt.slice(0, 10))}.{" "}
          {approved.journalId ? <Link href={`/operations/ledger-journals?journalId=${approved.journalId}`}>See the journal</Link> : null}
        </Notice>
      ) : problems.length > 0 ? (
        <Notice tone="warning">
          <strong>Not ready to approve:</strong>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {notices.map((notice) => (
        <Notice key={notice} tone="info">{notice}</Notice>
      ))}
      <div className={ui.statRow}>
        <Stat label="Opening value" value={<Money value={totals.openingValue} />} />
        <Stat label="Closing value" value={<Money value={totals.closingValue} />} />
        <Stat label="Taxable livestock profit" value={<Money value={totals.taxableProfit} />} />
        <Stat label="Herd scheme revaluation (non-taxable)" value={<Money value={totals.revaluation} />} />
        {workings.current && workings.current.classes.length > 0 ? <Stat label="Of the closing value, current (held for sale)" value={<Money value={workings.current.closingValue} />} /> : null}
      </div>
      <Card title="Livestock trading statement" description={`${formatDate(workings.yearStart)} to ${formatDate(workings.yearEnd)}, the ${workings.incomeYear - 1}-${String(workings.incomeYear).slice(2)} income year.`}>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>Sales</td>
                <td className={ui.num}>
                  <Money value={totals.sales} />
                </td>
              </tr>
              <tr>
                <td>less purchases</td>
                <td className={ui.num}>
                  <Money value={`-${totals.purchases}`} />
                </td>
              </tr>
              <tr>
                <td>plus closing value</td>
                <td className={ui.num}>
                  <Money value={totals.closingValue} />
                </td>
              </tr>
              <tr>
                <td>less opening value{Number(totals.revaluation) !== 0 ? ", revalued" : ""}</td>
                <td className={ui.num}>
                  <Money value={`-${totals.openingRevalued}`} />
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Taxable livestock profit</strong>
                </td>
                <td className={ui.num}>
                  <strong>
                    <Money value={totals.taxableProfit} />
                  </strong>
                </td>
              </tr>
              <tr>
                <td>Herd scheme revaluation (non-taxable, shown separately)</td>
                <td className={ui.num}>
                  <Money value={totals.revaluation} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className={ui.muted}>
          Value bridge: last year&apos;s closing <Money value={totals.openingValue} /> (as reported) + revaluation <Money value={totals.revaluation} /> = opening revalued{" "}
          <Money value={totals.openingRevalued} /> + change in value <Money value={totals.valueChange} /> = closing <Money value={totals.closingValue} />.
        </p>
      </Card>

      {workings.kinds.map((kind) => (
        <Card
          key={kind.kind}
          title={`${kind.kindName}: ${kind.method === "herd_scheme" ? "herd scheme" : "national standard cost"}${kind.herdValueRatio ? ` at ${kind.herdValueRatio} x NAMV` : ""}${kind.maleBreedingHerdScheme ? ", male breeding stock in the herd scheme" : ""}`}
        >
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Class</th>
                  <th className={ui.num}>Opening head</th>
                  <th className={ui.num}>Opening value</th>
                  <th className={ui.num}>{kind.method === "herd_scheme" ? "NAMV per head" : "NSC per head"}</th>
                  {kind.method === "herd_scheme" ? <th className={ui.num}>Opening revalued</th> : null}
                  <th className={ui.num}>Closing head</th>
                  <th className={ui.num}>Closing value</th>
                </tr>
              </thead>
              <tbody>
                {kind.classes.map((entry) => (
                  <tr key={entry.classCode}>
                    <td data-label="Class">{entry.className}</td>
                    <td data-label="Opening head" className={ui.num}>
                      {entry.openingHead}
                    </td>
                    <td data-label="Opening value" className={ui.num}>
                      <Money value={entry.openingValue} />
                    </td>
                    <td data-label="Per head" className={ui.num}>
                      {entry.rate ? <Money value={entry.rate} /> : "Mature group"}
                    </td>
                    {kind.method === "herd_scheme" ? (
                      <td data-label="Opening revalued" className={ui.num}>
                        <Money value={entry.openingRevalued} />
                      </td>
                    ) : null}
                    <td data-label="Closing head" className={ui.num}>
                      {entry.closingHead}
                    </td>
                    <td data-label="Closing value" className={ui.num}>
                      <Money value={entry.closingValue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kind.highPriced.length > 0 ? (
            <ul>
              {kind.highPriced.map((animal) => (
                <li key={animal.id}>
                  High-priced: {animal.description} ({animal.ratePercent}% a year): opening <Money value={animal.openingValue} />, closing <Money value={animal.closingValue} />
                  {animal.status === "reverted" ? " (reverted to its class at NAMV)" : animal.status === "left" ? " (sold or died)" : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {kind.nsc ? (
            <details>
              <summary>Mature group workings (averaged)</summary>
              <ul>
                <li>
                  Opening: {kind.nsc.matureOpeningHead} head, <Money value={kind.nsc.matureOpeningValue} />
                </li>
                <li>
                  Left in the year: {kind.nsc.matureOut} head; survivors at the opening average: <Money value={kind.nsc.survivorsValue} />
                </li>
                <li>
                  Last year&apos;s rising one-years joining: {kind.nsc.intakeHead} head at their value plus <Money value={kind.nsc.risingTwoRate} /> each:{" "}
                  <Money value={kind.nsc.intakeValue} />
                </li>
                <li>
                  Bought: {kind.nsc.purchasedHead} head at cost <Money value={kind.nsc.purchasedCost} />
                </li>
                <li>
                  Closing: {kind.nsc.matureClosingHead} head, <Money value={kind.nsc.matureClosingValue} /> (average <Money value={kind.nsc.matureAverage} />)
                </li>
              </ul>
            </details>
          ) : null}
          <p className={ui.muted}>
            Sales <Money value={kind.sales} />, purchases <Money value={kind.purchases} />, change in value <Money value={kind.valueChange} />
            {kind.method === "herd_scheme" ? (
              <>
                , revaluation <Money value={kind.revaluation} />
              </>
            ) : null}
            ; taxable profit <Money value={kind.taxableProfit} />.
          </p>
        </Card>
      ))}

      <Card
        title="Journal"
        description={`Posted at ${formatDate(yearEnd)} when approved. The herd scheme revaluation goes to ${revaluationTarget === "reserve" ? "an equity reserve" : "profit and loss, as its own non-taxable line"} (Livestock settings). Classes held for sale are moved to the current asset account.`}
      >
        {journal.length === 0 ? (
          <p className={ui.muted}>Nothing to post.</p>
        ) : (
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
                {journal.map((line, index) => (
                  <tr key={index}>
                    <td data-label="Account">
                      {line.accountCode} {line.accountName}
                    </td>
                    <td data-label="Description">{line.description}</td>
                    <td data-label="Debit" className={ui.num}>
                      <Money value={line.debit} blankZero />
                    </td>
                    <td data-label="Credit" className={ui.num}>
                      <Money value={line.credit} blankZero />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can("admin") && !approved ? (
          <Button disabled={busy || problems.length > 0} onClick={() => void approve()}>
            Approve and post
          </Button>
        ) : null}
        {can("admin") && approved ? (
          <div className={ui.inlineForm}>
            <Field label="Why replace it">
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
            <Button variant="danger" disabled={busy || reason.trim() === ""} onClick={() => void replace()}>
              Replace
            </Button>
          </div>
        ) : null}
        {!can("admin") ? <p className={ui.muted}>An admin (the accountant) approves the valuation.</p> : null}
      </Card>
    </>
  );
}
