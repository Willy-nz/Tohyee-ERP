"use client";

import { type FormEvent,useState } from "react";
import { Money } from "@/components/books";
import Link from "next/link";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { ENTITY_TYPE_LABELS } from "@/lib/organisations/entity-types";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate,formatMoney } from "@/lib/format";
import { EXPENSE_TREATMENTS,INCOME_TREATMENTS,TAXPAYER_TYPE_LABELS,TREATMENT_LABELS,type TaxpayerType,type Treatment } from "@/lib/tax/income/rules";
import type { IncomeTaxSettings,ReportAccount } from "@/lib/tax/income/service";
import { TRUST_CLASS_LABELS, TRUST_CLASSES, type TrustClass } from "@/lib/tax/income/trust-return";
import { TRUST_KIND_LABELS, TRUST_KINDS, type TrustKind } from "@/lib/tax/income/trusts";
import { Status,Supported,negated } from "@/components/income-tax/shared";

export function Settings({ organisationId, settings, onSaved }: { organisationId: string; settings: IncomeTaxSettings; onSaved: () => void }) {
  const [type, setType] = useState<TaxpayerType | "">(settings.taxpayerType ?? "");
  const [extension, setExtension] = useState(settings.agentExtension);
  const [trustKind, setTrustKind] = useState<TrustKind>(settings.trustKind);
  const [dateOfDeath, setDateOfDeath] = useState(settings.dateOfDeath ?? "");
  const [trustClass, setTrustClass] = useState<TrustClass>(settings.trustClass);
  const [status, setStatus] = useState<Status>(null);
  const isTrust = (settings.entityType ? settings.taxpayerType : type) === "trust";
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/settings", { method: "PUT", body: {
          organisationId,
          taxpayerType: settings.entityType ? settings.taxpayerType : type,
          agentExtension: extension,
          version: settings.version,
          ...(isTrust ? { trustKind, dateOfDeath: trustKind === "deceased_estate" ? dateOfDeath || null : null, trustClass } : {}),
        },
      });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card title="Taxpayer" description="Who pays the tax, and whether a tax agent's extension of time moves end-of-year tax to 7 April.">
      {settings.unsupported ? <Notice tone="warning">{settings.unsupported}</Notice> : null}
      <form className={ui.inlineForm} onSubmit={save}>
        {settings.entityType ? (
          // ENT3: Settings › Business structure decides it.
          <p>
            This organisation is a {ENTITY_TYPE_LABELS[settings.entityType].toLowerCase()}
            {settings.taxpayerType && !settings.unsupported && TAXPAYER_TYPE_LABELS[settings.taxpayerType] !== ENTITY_TYPE_LABELS[settings.entityType]
              ? ` (${TAXPAYER_TYPE_LABELS[settings.taxpayerType].toLowerCase()})`
              : ""}
            .{" "}
            <Link href="/operations/settings#business-structure">Change in Settings</Link>
          </p>
        ) : (
        <Field label="This organisation is">
          <select value={type} onChange={(event) => setType(event.target.value as TaxpayerType | "")} required>
            <option value="">Choose…</option>
            {(Object.keys(TAXPAYER_TYPE_LABELS) as TaxpayerType[]).map((value) => (
              <option key={value} value={value}>
                {TAXPAYER_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        )}
        {isTrust ? (
          // TRU1, TRU5, TRU6: the kind of trust sets the trustee's rate.
          <>
            <Field label="Kind of trust">
              <select value={trustKind} onChange={(event) => setTrustKind(event.target.value as TrustKind)}>
                {TRUST_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {TRUST_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Complying, foreign or non-complying" hint="Sets whether distributions other than beneficiary income are taxable.">
              <select value={trustClass} onChange={(event) => setTrustClass(event.target.value as TrustClass)}>
                {TRUST_CLASSES.map((value) => (
                  <option key={value} value={value}>
                    {TRUST_CLASS_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            {trustKind === "deceased_estate" ? (
              <Field label="Date of death" hint="33% for the income year of the death and the three after it.">
                <input type="date" value={dateOfDeath} onChange={(event) => setDateOfDeath(event.target.value)} />
              </Field>
            ) : null}
          </>
        ) : null}
        <label className={ui.checkbox}>
          <input type="checkbox" checked={extension} onChange={(event) => setExtension(event.target.checked)} /> A tax agent with an extension of time files the return
        </label>
        <Button type="submit" disabled={Boolean(settings.unsupported)}>Save</Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}

function TreatmentCell({ organisationId, account, onSaved }: { organisationId: string; account: ReportAccount; onSaved: () => void }) {
  const [treatment, setTreatment] = useState<Treatment>(account.treatment);
  const [percent, setPercent] = useState(account.businessUsePercent ?? "");
  const [error, setError] = useState<string | null>(null);
  const choices = account.side === "income" ? INCOME_TREATMENTS : EXPENSE_TREATMENTS;
  async function save(next: Treatment, nextPercent: string) {
    try {
      setError(null);
      await api("/api/income-tax/treatments", { method: "PUT", body: { organisationId, accountId: account.accountId, treatment: next, businessUsePercent: next === "business_use" ? nextPercent : undefined } });
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <>
      <select
        aria-label={`Tax treatment of ${account.code} ${account.name}`}
        value={treatment}
        onChange={(event) => {
          const next = event.target.value as Treatment;
          setTreatment(next);
          if (next !== "business_use") void save(next, "");
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {TREATMENT_LABELS[choice]}
          </option>
        ))}
      </select>
      {treatment === "business_use" ? (
        <span>
          {" "}
          <input aria-label={`Business use % of ${account.code}`} inputMode="decimal" size={5} value={percent} onChange={(event) => setPercent(event.target.value)} />%{" "}
          <Button size="small" variant="secondary" onClick={() => void save("business_use", percent)}>
            Save
          </Button>
        </span>
      ) : null}
      {error ? <div className={ui.error}>{error}</div> : null}
    </>
  );
}

export function Workpaper({ organisationId, report, onSaved }: { organisationId: string; report: Supported; onSaved: () => void }) {
  const paper = report.workpaper;
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("tax-adj"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/adjustments", { method: "POST", body: { organisationId, idempotencyKey: key, incomeYear: report.incomeYear, description, amount } });
      setDescription("");
      setAmount("");
      setKey(newIdempotencyKey("tax-adj"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/adjustments/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const typedIds = new Map(report.adjustments.map((entry) => [entry.description + "|" + entry.amount, entry.id]));
  const showBudget = report.budgetFrom !== null;
  return (
    <Card
      title="Taxable income"
      description={
        report.actualsTo
          ? `Actuals to ${formatDate(report.actualsTo)}${showBudget ? `, then the ${report.budgetName ?? "overall budget"} from ${formatDate(report.budgetFrom!)}` : ""}. Change how an account counts for tax in the Treatment column.`
          : `The ${report.budgetName ?? "overall budget"} for the whole year (nothing's happened yet).`
      }
    >
      {report.accounts.length === 0 ? (
        <Empty>No income or expenses for this year yet.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={ui.num}>Actual</th>
                {showBudget ? <th className={ui.num}>Budget</th> : null}
                <th className={ui.num}>For the year</th>
                <th>Treatment</th>
                <th className={ui.num}>Tax adjustment</th>
              </tr>
            </thead>
            <tbody>
              {report.accounts.map((account) => (
                <tr key={account.accountId}>
                  <td data-label="Account">
                    {account.code} {account.name} <span className={ui.muted}>({account.side})</span>
                  </td>
                  <td data-label="Actual" className={ui.num}>
                    <Money value={account.actual} blankZero />
                  </td>
                  {showBudget ? (
                    <td data-label="Budget" className={ui.num}>
                      <Money value={account.budget} blankZero />
                    </td>
                  ) : null}
                  <td data-label="For the year" className={ui.num}>
                    <Money value={account.total} />
                  </td>
                  <td data-label="Treatment">
                    <TreatmentCell key={`${account.accountId}-${account.treatment}-${account.businessUsePercent}`} organisationId={organisationId} account={account} onSaved={onSaved} />
                  </td>
                  <td data-label="Tax adjustment" className={ui.num}>
                    <Money value={account.adjustment} blankZero />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={ui.tableWrap}>
        <table className={ui.reportTable}>
          <tbody>
            <tr className={ui.reportTotal}>
              <td>Net profit</td>
              <td className={ui.num}>
                <Money value={paper.netProfit} />
              </td>
            </tr>
            {paper.adjustments.map((entry, index) => {
              const typedId = entry.accountId === null ? typedIds.get(entry.description + "|" + entry.amount) : undefined;
              return (
                <tr key={`${entry.description}-${index}`}>
                  <td>
                    {entry.description}{" "}
                    {typedId ? (
                      <>
                        <Badge>Typed</Badge>{" "}
                        <button type="button" className={ui.linkButton} onClick={() => void remove(typedId)}>
                          Remove
                        </button>
                      </>
                    ) : null}
                  </td>
                  <td className={ui.num}>
                    <Money value={entry.amount} />
                  </td>
                </tr>
              );
            })}
            {report.settings.taxpayerType === "individual" ? (
              <tr>
                <td>Other income (typed)</td>
                <td className={ui.num}>
                  <Money value={paper.otherIncome} />
                </td>
              </tr>
            ) : null}
            <tr className={ui.reportTotal}>
              <td>Taxable income before losses</td>
              <td className={ui.num}>
                <Money value={paper.beforeLosses} />
              </td>
            </tr>
            <tr>
              <td>
                Losses brought forward used (of <Money value={paper.lossesBroughtForward} />)
              </td>
              <td className={ui.num}>
                <Money value={negated(paper.lossesUsed)} />
              </td>
            </tr>
            <tr className={ui.reportTotal}>
              <td>Taxable income</td>
              <td className={ui.num}>
                <Money value={paper.taxableIncome} />
              </td>
            </tr>
            <tr>
              <td>Tax</td>
              <td className={ui.num}>
                <Money value={paper.tax} />
              </td>
            </tr>
            {paper.overseasTaxPaid !== "0.00" ? (
              <tr>
                <td>Overseas tax paid (typed; not below nil)</td>
                <td className={ui.num}>
                  <Money value={negated(paper.overseasTaxPaid)} />
                </td>
              </tr>
            ) : null}
            {paper.imputationCredits !== "0.00" ? (
              <tr>
                <td>Imputation credits received (typed; not below nil)</td>
                <td className={ui.num}>
                  <Money value={negated(paper.imputationCredits)} />
                </td>
              </tr>
            ) : null}
            <tr>
              <td>Tax credits: RWT, PAYE and others (typed)</td>
              <td className={ui.num}>
                <Money value={negated(paper.taxCredits)} />
              </td>
            </tr>
            <tr className={ui.reportTotal}>
              <td>Residual income tax (RIT)</td>
              <td className={ui.num}>
                <Money value={paper.rit} />
              </td>
            </tr>
            <tr>
              <td>Loss carried forward{paper.imputationLoss !== "0.00" ? ` (including ${formatMoney(paper.imputationLoss)} from excess imputation credits)` : ""}</td>
              <td className={ui.num}>
                <Money value={paper.lossCarriedForward} />
              </td>
            </tr>
            {paper.excessImputationCredits !== "0.00" && paper.imputationLoss === "0.00" ? (
              <tr>
                <td>Excess imputation credits carried forward</td>
                <td className={ui.num}>
                  <Money value={paper.excessImputationCredits} />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Other adjustment" hint="For example, holiday pay not paid within 63 days. Positive adds to taxable income; negative takes off.">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="Amount">
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </Field>
        <Button type="submit" variant="secondary">
          Add adjustment
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}
