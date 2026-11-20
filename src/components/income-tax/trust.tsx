"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { BeneficiaryIncome, BeneficiaryRecord } from "@/lib/tax/income/beneficiaries";
import type { Ir6Figures } from "@/lib/tax/income/service";
import type { TrustTax } from "@/lib/tax/income/trusts";

/*
 * A trust's income tax screens (TRT1-TRT14): the beneficiary list, a year's
 * beneficiary income and what it means for the trust's tax, and the IR6
 * figures.
 */

/** The trust's beneficiaries (TRT2). */
export function BeneficiariesCard({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ beneficiaries: BeneficiaryRecord[] }>("/api/income-tax/beneficiaries", { organisationId, includeArchived: "true" });
  const [editing, setEditing] = useState<BeneficiaryRecord | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = loaded.data?.beneficiaries ?? [];
  async function archive(beneficiary: BeneficiaryRecord, archived: boolean) {
    setError(null);
    try {
      await api(`/api/income-tax/beneficiaries/${beneficiary.id}`, { method: "PATCH", body: { organisationId, archived } });
      loaded.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  async function remove(beneficiary: BeneficiaryRecord) {
    setError(null);
    try {
      await api(`/api/income-tax/beneficiaries/${beneficiary.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      loaded.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <Card title="Beneficiaries" description="Who the trust can allocate beneficiary income to. Ages and the company rule decide what the trustee pays tax on at 39%.">
      {error || loaded.error ? <Notice tone="error">{error ?? loaded.error}</Notice> : null}
      {list.length === 0 && loaded.data ? <Empty>No beneficiaries yet.</Empty> : null}
      {list.length ? (
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Details</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((beneficiary) => (
              <tr key={beneficiary.id}>
                <td>
                  {beneficiary.name} {beneficiary.archived ? <Badge>Archived</Badge> : null}
                </td>
                <td>{describe(beneficiary)}</td>
                <td className={ui.num}>
                  <div className={ui.actions}>
                    <Button variant="secondary" size="small" onClick={() => setEditing(beneficiary)}>
                      Edit
                    </Button>
                    {beneficiary.hasIncome ? (
                      <Button variant="secondary" size="small" onClick={() => void archive(beneficiary, !beneficiary.archived)}>
                        {beneficiary.archived ? "Restore" : "Archive"}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="small" onClick={() => void remove(beneficiary)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {editing ? (
        <BeneficiaryForm
          key={editing === "new" ? "new" : editing.id}
          organisationId={organisationId}
          beneficiary={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            loaded.reload();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className={ui.actions}>
          <Button onClick={() => setEditing("new")}>Add a beneficiary</Button>
        </div>
      )}
    </Card>
  );
}

function describe(beneficiary: BeneficiaryRecord): string {
  if (beneficiary.kind === "company") return beneficiary.corporateRule ? "Company: corporate beneficiary rule applies" : "Company: corporate beneficiary rule doesn't apply";
  const parts = [beneficiary.dateOfBirth ? `Born ${formatDate(beneficiary.dateOfBirth)}` : "No date of birth"];
  if (!beneficiary.settledByRelative) parts.push("trust not settled by a relative or guardian");
  if (beneficiary.disabilityAllowance) parts.push("disability allowance");
  return parts.join(", ");
}

function BeneficiaryForm({ organisationId, beneficiary, onDone, onCancel }: { organisationId: string; beneficiary: BeneficiaryRecord | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(beneficiary?.name ?? "");
  const [kind, setKind] = useState<"person" | "company">(beneficiary?.kind ?? "person");
  const [dateOfBirth, setDateOfBirth] = useState(beneficiary?.dateOfBirth ?? "");
  const [settledByRelative, setSettledByRelative] = useState(beneficiary?.settledByRelative ?? true);
  const [disabilityAllowance, setDisabilityAllowance] = useState(beneficiary?.disabilityAllowance ?? false);
  const [corporateRule, setCorporateRule] = useState(beneficiary?.corporateRule ?? true);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body = { organisationId, name, kind, dateOfBirth: kind === "person" ? dateOfBirth || null : null, settledByRelative, disabilityAllowance: kind === "person" && disabilityAllowance, corporateRule };
    try {
      if (beneficiary) await api(`/api/income-tax/beneficiaries/${beneficiary.id}`, { method: "PATCH", body });
      else await api("/api/income-tax/beneficiaries", { method: "POST", body });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <form className={ui.stack} onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Name">
          <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="A person or a company">
          <select value={kind} onChange={(event) => setKind(event.target.value as "person" | "company")}>
            <option value="person">Person</option>
            <option value="company">Company</option>
          </select>
        </Field>
        {kind === "person" ? (
          <Field label="Date of birth" hint="For the minor beneficiary rule (under 16).">
            <input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} />
          </Field>
        ) : null}
      </div>
      {kind === "person" ? (
        <>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={settledByRelative} onChange={(event) => setSettledByRelative(event.target.checked)} /> The trust was settled by a relative or guardian of
            theirs
          </label>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={disabilityAllowance} onChange={(event) => setDisabilityAllowance(event.target.checked)} /> A disability allowance or child disability
            allowance is paid for them
          </label>
        </>
      ) : (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={corporateRule} onChange={(event) => setCorporateRule(event.target.checked)} /> The corporate beneficiary rule applies (a close company with a
          settlor, or someone a settlor has natural love and affection for, as a shareholder)
        </label>
      )}
      <div className={ui.actions}>
        <Button type="submit">{beneficiary ? "Save" : "Add"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A year's beneficiary income, and the trust's tax it leads to (TRT3-TRT11). */
export function BeneficiaryIncomeCard({ organisationId, incomeYear, trust, onSaved }: { organisationId: string; incomeYear: number; trust: TrustTax; onSaved: () => void }) {
  const people = useApiData<{ beneficiaries: BeneficiaryRecord[] }>("/api/income-tax/beneficiaries", { organisationId, includeArchived: "true" });
  const income = useApiData<{ lines: BeneficiaryIncome[] }>("/api/income-tax/beneficiary-income", { organisationId, incomeYear: String(incomeYear) });
  if (!people.data || !income.data) return <Card title="Beneficiary income">{people.error || income.error ? <Notice tone="error">{people.error ?? income.error}</Notice> : <p className={ui.muted}>Loading…</p>}</Card>;
  return (
    <IncomeForm
      key={`${incomeYear}-${JSON.stringify(income.data.lines)}`}
      organisationId={organisationId}
      incomeYear={incomeYear}
      beneficiaries={people.data.beneficiaries}
      lines={income.data.lines}
      trust={trust}
      onSaved={() => {
        income.reload();
        onSaved();
      }}
    />
  );
}

function IncomeForm({
  organisationId,
  incomeYear,
  beneficiaries,
  lines,
  trust,
  onSaved,
}: {
  organisationId: string;
  incomeYear: number;
  beneficiaries: BeneficiaryRecord[];
  lines: BeneficiaryIncome[];
  trust: TrustTax;
  onSaved: () => void;
}) {
  const allocated = new Map(lines.map((line) => [line.beneficiaryId, line.amount]));
  // Archived beneficiaries show only when they have income this year.
  const shown = beneficiaries.filter((beneficiary) => !beneficiary.archived || allocated.has(beneficiary.id));
  const [amounts, setAmounts] = useState<Record<string, string>>(Object.fromEntries(shown.map((beneficiary) => [beneficiary.id, allocated.get(beneficiary.id) ?? ""])));
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const treatment = new Map(trust.lines.map((line) => [line.beneficiaryId, line]));
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/beneficiary-income", {
        method: "PUT",
        body: { organisationId, incomeYear, lines: shown.map((beneficiary) => ({ beneficiaryId: beneficiary.id, amount: amounts[beneficiary.id] ?? "" })) },
      });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (failure) {
      setStatus({ tone: "error", text: errorMessage(failure) });
    }
  }
  return (
    <Card title="Beneficiary income" description="Income vested in or paid to each beneficiary this year. It comes off the trust's net income; the rest is trustee income.">
      {shown.length === 0 ? (
        <Empty>Add the trust&apos;s beneficiaries under Tax settings first.</Empty>
      ) : (
        <form onSubmit={save}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Beneficiary</th>
                <th className={ui.num}>Beneficiary income</th>
                <th>Taxed</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((beneficiary) => {
                const line = treatment.get(beneficiary.id);
                return (
                  <tr key={beneficiary.id}>
                    <td>{beneficiary.name}</td>
                    <td className={ui.num}>
                      <input
                        aria-label={`${beneficiary.name}'s beneficiary income`}
                        inputMode="decimal"
                        value={amounts[beneficiary.id] ?? ""}
                        onChange={(event) => setAmounts((current) => ({ ...current, [beneficiary.id]: event.target.value }))}
                      />
                    </td>
                    <td>{line ? <>{line.taxedByTrustee ? <Badge tone="amber">By the trustee, 39%</Badge> : null} {line.reason}</> : <span className={ui.muted}>None this year</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={ui.actions}>
            <Button type="submit">Save beneficiary income</Button>
          </div>
        </form>
      )}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {trust.notes.map((note) => (
        <Notice key={note} tone="warning">
          {note}
        </Notice>
      ))}
      <table className={ui.table}>
        <tbody>
          <tr>
            <td>Net income</td>
            <td className={ui.num}>
              <Money value={trust.netIncome} />
            </td>
          </tr>
          <tr>
            <td>Beneficiary income taxed to the beneficiaries</td>
            <td className={ui.num}>
              <Money value={trust.ordinaryBeneficiaryIncome} />
            </td>
          </tr>
          <tr>
            <td>Minor and corporate beneficiary income, taxed by the trustee at 39%</td>
            <td className={ui.num}>
              <Money value={trust.minorCorporateIncome} />
            </td>
          </tr>
          <tr>
            <td>Trustee net income</td>
            <td className={ui.num}>
              <Money value={trust.trusteeNetIncome} />
            </td>
          </tr>
          {trust.lossesUsed !== "0.00" ? (
            <tr>
              <td>Losses brought forward used</td>
              <td className={ui.num}>
                <Money value={trust.lossesUsed} />
              </td>
            </tr>
          ) : null}
          <tr>
            <td>Trustee income</td>
            <td className={ui.num}>
              <Money value={trust.trusteeIncome} />
            </td>
          </tr>
          <tr>
            <td>Tax on trustee income ({trust.trusteeRateReason})</td>
            <td className={ui.num}>
              <Money value={trust.trusteeTax} />
            </td>
          </tr>
          <tr>
            <td>Tax on minor and corporate beneficiary income</td>
            <td className={ui.num}>
              <Money value={trust.minorCorporateTax} />
            </td>
          </tr>
          <tr>
            <th>The trust&apos;s tax</th>
            <th className={ui.num}>
              <Money value={trust.tax} />
            </th>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

/** The IR6 boxes Tohyee works out (TRT14). */
export function Ir6Card({ incomeYear, ir6 }: { incomeYear: number; ir6: Ir6Figures }) {
  const rows: Array<[string, string]> = [
    ["21A Beneficiary income (excluding minor and corporate beneficiaries)", ir6["21A"]],
    ["21C Minor and corporate beneficiary income", ir6["21C"]],
    ["28C Tax on minor and corporate beneficiary income (21C × 39%)", ir6["28C"]],
    ["Trustee income", ir6.trusteeIncome],
    [`Tax on trustee income at ${ir6.trusteeRate.replace(/^0\./, "")}%`, ir6.trusteeTax],
    ["The trust's tax", ir6.totalTax],
  ];
  return (
    <Card title={`IR6 trust return: beneficiary and trustee income (${incomeYear})`} description="The figures Tohyee works out. Other boxes aren't filled in.">
      <table className={ui.table}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className={ui.num}>
                <Money value={value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
