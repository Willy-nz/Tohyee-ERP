"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { BeneficiaryIncome, BeneficiaryRecord } from "@/lib/tax/income/beneficiaries";
import type { Ir6Box, Ir6Figures, TrustClass, TrustReturn } from "@/lib/tax/income/trust-return";
import type { TrustTax } from "@/lib/tax/income/trusts";

/*
 * A trust's income tax screens (TRU1-TRU27): the beneficiary list, a year's
 * beneficiary income, distributions and credits and what they mean for the
 * trust's tax, and the IR6 and IR6B figures.
 */

/** The trust's beneficiaries (TRU2). */
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
  const ird = beneficiary.irdNumber ? `IRD ${formatIrd(beneficiary.irdNumber)}` : beneficiary.tin ? `${beneficiary.jurisdiction ?? "Overseas"} tax number ${beneficiary.tin}` : "No IRD number";
  return `${describeRule(beneficiary)}. ${ird}`;
}

function formatIrd(nine: string): string {
  const digits = nine.startsWith("0") ? nine.slice(1) : nine;
  return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
}

function describeRule(beneficiary: BeneficiaryRecord): string {
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
  const [irdNumber, setIrdNumber] = useState(beneficiary?.irdNumber ? formatIrd(beneficiary.irdNumber) : "");
  const [overseas, setOverseas] = useState(Boolean(beneficiary?.jurisdiction));
  const [jurisdiction, setJurisdiction] = useState(beneficiary?.jurisdiction ?? "");
  const [tin, setTin] = useState(beneficiary?.tin ?? "");
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body = { organisationId, name, kind, dateOfBirth: kind === "person" ? dateOfBirth || null : null, settledByRelative, disabilityAllowance: kind === "person" && disabilityAllowance,
      corporateRule,
      irdNumber: irdNumber.trim(),
      jurisdiction: overseas ? jurisdiction.trim() : "",
      tin: overseas ? tin.trim() : "",
    };
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
        <Field label="IRD number" hint="For the IR6B. Leave blank if they don't have one.">
          <input value={irdNumber} inputMode="numeric" maxLength={11} onChange={(event) => setIrdNumber(event.target.value)} />
        </Field>
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={overseas} onChange={(event) => setOverseas(event.target.checked)} /> Resident for tax outside New Zealand
      </label>
      {overseas ? (
        <div className={ui.inlineForm}>
          <Field label="Country">
            <input value={jurisdiction} maxLength={100} onChange={(event) => setJurisdiction(event.target.value)} />
          </Field>
          <Field label="Tax number there" hint="Blank if the country doesn't issue them.">
            <input value={tin} maxLength={50} onChange={(event) => setTin(event.target.value)} />
          </Field>
        </div>
      ) : null}
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

/** A year's beneficiary income, distributions and credits, and the trust's tax they lead to (TRU3-TRU24). */
export function BeneficiaryIncomeCard({
  organisationId,
  incomeYear,
  trust,
  ret,
  trustClass,
  onSaved,
}: {
  organisationId: string;
  incomeYear: number;
  trust: TrustTax;
  ret: TrustReturn | null;
  trustClass: TrustClass;
  onSaved: () => void;
}) {
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
      ret={ret}
      trustClass={trustClass}
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
  ret,
  trustClass,
  onSaved,
}: {
  organisationId: string;
  incomeYear: number;
  beneficiaries: BeneficiaryRecord[];
  lines: BeneficiaryIncome[];
  trust: TrustTax;
  ret: TrustReturn | null;
  trustClass: TrustClass;
  onSaved: () => void;
}) {
  const allocated = new Map(lines.map((line) => [line.beneficiaryId, line]));
  // Archived beneficiaries show only when they have figures this year.
  const shown = beneficiaries.filter((beneficiary) => !beneficiary.archived || allocated.has(beneficiary.id));
  const [rows, setRows] = useState<Record<string, Draft>>(Object.fromEntries(shown.map((beneficiary) => [beneficiary.id, toDraft(allocated.get(beneficiary.id))])));
  const set = (id: string, change: Partial<Draft>) => setRows((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  const statements = new Map((ret?.statements ?? []).map((statement) => [statement.beneficiaryId, statement]));
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const treatment = new Map(trust.lines.map((line) => [line.beneficiaryId, line]));
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/beneficiary-income", {
        method: "PUT",
        body: { organisationId, incomeYear, lines: shown.map((beneficiary) => ({ beneficiaryId: beneficiary.id, ...rows[beneficiary.id] })) },
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
                const row = rows[beneficiary.id];
                const statement = statements.get(beneficiary.id);
                return (
                  <tr key={beneficiary.id}>
                    <td>
                      {beneficiary.name}
                      <details className={ui.fieldSection}>
                        <summary>Distributions and tax</summary>
                        <div className={ui.stack}>
                          {trustClass !== "complying" ? (
                            <Field label="Taxable distribution" hint="Beyond beneficiary income: accumulated trustee income or capital gains, not corpus.">
                              <input inputMode="decimal" value={row.taxableDistribution} onChange={(event) => set(beneficiary.id, { taxableDistribution: event.target.value })} />
                            </Field>
                          ) : null}
                          <Field label="Distribution that isn't taxable" hint="Corpus, capital, or assets given or lent below market value.">
                            <input inputMode="decimal" value={row.nonTaxableDistribution} onChange={(event) => set(beneficiary.id, { nonTaxableDistribution: event.target.value })} />
                          </Field>
                          <Field label="Taken out of their current account" hint="A minus is money paid back.">
                            <input inputMode="decimal" value={row.withdrawn} onChange={(event) => set(beneficiary.id, { withdrawn: event.target.value })} />
                          </Field>
                          <Field label="Opening balance owed to them" hint="Blank: last year's closing balance.">
                            <input inputMode="decimal" value={row.openingBalance} onChange={(event) => set(beneficiary.id, { openingBalance: event.target.value })} />
                          </Field>
                          <label className={ui.checkbox}>
                            <input type="checkbox" checked={row.trusteePaysTax} onChange={(event) => set(beneficiary.id, { trusteePaysTax: event.target.checked })} /> The trust pays their tax on it
                          </label>
                          {row.trusteePaysTax ? (
                            <Field label="Their other taxable income" hint="To work out their tax on the trust income.">
                              <input inputMode="decimal" value={row.otherIncome} onChange={(event) => set(beneficiary.id, { otherIncome: event.target.value })} />
                            </Field>
                          ) : null}
                        </div>
                      </details>
                    </td>
                    <td className={ui.num}>
                      <input
                        aria-label={`${beneficiary.name}'s beneficiary income`}
                        inputMode="decimal"
                        value={row.amount}
                        onChange={(event) => set(beneficiary.id, { amount: event.target.value })}
                      />
                    </td>
                    <td>
                      {line ? <>{line.taxedByTrustee ? <Badge tone="amber">By the trustee, 39%</Badge> : null} {line.reason}</> : <span className={ui.muted}>No beneficiary income this year</span>}
                      {statement && statement.taxPayable !== "0.00" ? (
                        <div>
                          The trust pays <Money value={statement.taxPayable} /> of tax for them.
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={ui.actions}>
            <Button type="submit">Save</Button>
          </div>
        </form>
      )}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {[...trust.notes, ...(ret?.notes ?? [])].map((note) => (
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
            <th>The trust&apos;s tax, before credits</th>
            <th className={ui.num}>
              <Money value={trust.tax} />
            </th>
          </tr>
        </tbody>
      </table>
      {ret ? <CreditsTable ret={ret} /> : null}
    </Card>
  );
}

type Draft = { amount: string; trusteePaysTax: boolean; otherIncome: string; taxableDistribution: string; nonTaxableDistribution: string; withdrawn: string; openingBalance: string };

function toDraft(line: BeneficiaryIncome | undefined): Draft {
  const blank = (value: string | null | undefined) => (value === null || value === undefined || value === "0.00" ? "" : value);
  return {
    amount: blank(line?.amount),
    trusteePaysTax: line?.trusteePaysTax ?? false,
    otherIncome: blank(line?.otherIncome),
    taxableDistribution: blank(line?.taxableDistribution),
    nonTaxableDistribution: blank(line?.nonTaxableDistribution),
    withdrawn: blank(line?.withdrawn),
    openingBalance: line?.openingBalance ?? "",
  };
}

/** How the trust's credits are shared (TRU15). */
function CreditsTable({ ret }: { ret: TrustReturn }) {
  const rows: Array<[string, keyof TrustReturn["totalCredits"]]> = [
    ["Overseas tax paid", "overseas"],
    ["Imputation credits", "imputation"],
    ["RWT and other credits", "other"],
  ];
  if (rows.every(([, key]) => ret.totalCredits[key] === "0.00")) return null;
  return (
    <table className={ui.table}>
      <thead>
        <tr>
          <th>Credits</th>
          <th className={ui.num}>The trust&apos;s</th>
          <th className={ui.num}>Passed to beneficiaries</th>
          <th className={ui.num}>The trustee&apos;s</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, key]) => (
          <tr key={key}>
            <td>{label}</td>
            <td className={ui.num}>
              <Money value={ret.totalCredits[key]} />
            </td>
            <td className={ui.num}>
              <Money value={ret.passedOn[key]} />
            </td>
            <td className={ui.num}>
              <Money value={ret.trusteeCredits[key]} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The IR6 and IR6B boxes Tohyee works out (TRU14, TRU25, TRU26). */
export function Ir6Card({ incomeYear, ir6 }: { incomeYear: number; ir6: Ir6Figures }) {
  return (
    <Card title={`IR6 trust return (${incomeYear})`} description={`Box numbers from the ${ir6.form} IR6 and IR6B. Boxes Tohyee doesn't work out are left out.`}>
      {ir6.notes.map((note) => (
        <Notice key={note} tone="info">
          {note}
        </Notice>
      ))}
      <BoxTable boxes={ir6.boxes} />
      {ir6.beneficiaries.map((entry) => (
        <details key={entry.beneficiaryId} className={ui.fieldSection}>
          <summary>
            IR6B: {entry.name} {entry.ruleApplies ? <Badge tone="amber">Minor or corporate beneficiary rule</Badge> : null}
          </summary>
          <p className={ui.muted}>
            {[entry.dateOfBirth ? `Born ${formatDate(entry.dateOfBirth)}` : null, entry.irdNumber ? `IRD number ${formatIrd(entry.irdNumber)}` : null, entry.tin ? `${entry.jurisdiction ?? "Overseas"} tax number ${entry.tin}` : entry.jurisdiction ? `Resident in ${entry.jurisdiction}` : null]
              .filter(Boolean)
              .join(" · ") || "No date of birth or IRD number."}
          </p>
          <BoxTable boxes={entry.boxes} />
        </details>
      ))}
    </Card>
  );
}

function BoxTable({ boxes }: { boxes: Ir6Box[] }) {
  return (
    <table className={ui.table}>
      <tbody>
        {boxes.map((box) => (
          <tr key={box.box}>
            <td>
              {box.box} {box.label}
            </td>
            <td className={ui.num}>
              <Money value={box.amount} /> {box.side === "credit" ? "Credit" : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
