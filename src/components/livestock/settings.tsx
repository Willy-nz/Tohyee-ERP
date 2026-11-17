"use client";

import { InfoTip } from "@/components/info-tip";
import { DateInput } from "@/components/date-input";
import { useState } from "react";
import { AccountSelect,Money,useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { CHATHAM_KINDS,classesOf,KIND_NAMES,LIVESTOCK_KINDS,type LivestockKind,NSC_KIND_NAMES } from "@/lib/livestock/classes";
import type { LivestockLocation,LivestockOpening,LivestockSettings } from "@/lib/livestock/movements";
import type { Election,Rate } from "@/lib/livestock/valuation";
import { useLivestockSettings } from "@/components/livestock/shared";
import { HighPricedCard } from "@/components/livestock/management";

// Settings ---------------------------------------------------------------------------

export function LivestockSettingsPanel({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useLivestockSettings(organisationId);
  const accounts = useAccounts(organisationId);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [firstYearStart, setFirstYearStart] = useState("");
  const isAdmin = can("admin");
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  const current = settings.data.settings;

  async function patch(body: Record<string, unknown>, text: string) {
    setError(null);
    try {
      await api("/api/livestock/settings", { method: "PATCH", body: { organisationId, ...body } });
      setMessage(text);
      settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card title="Livestock" description="Part of Accounting. Dairy cattle, beef cattle and sheep, by IRD's classes.">
        {current.enabled ? (
          <>
            <p>
            On, from the year starting {formatDate(current.firstYearStart)}.{" "}
            {isAdmin ? (
              <Button variant="secondary" size="small" onClick={() => void patch({ enabled: false }, "Livestock turned off. Its records are kept.")}>
                Turn off
              </Button>
            ) : null}
            </p>
            {isAdmin ? (
              <div className={ui.inlineForm}>
                <Field label="First income year starts" hint="Can change until movements are recorded. The opening position is as at the day before.">
                  <DateInput value={firstYearStart || current.firstYearStart || ""} onChange={(event) => setFirstYearStart(event.target.value)} />
                </Field>
                <Button variant="secondary" disabled={!firstYearStart || firstYearStart === current.firstYearStart} onClick={() => void patch({ firstYearStart }, "The first year is changed.")}>
                  Change
                </Button>
              </div>
            ) : null}
          </>
        ) : isAdmin ? (
          <div className={ui.inlineForm}>
            <Field label="First income year starts" hint="The first day of the financial year Tohyee's livestock records start in. Its opening comes from last year's workpaper.">
              <DateInput value={firstYearStart || current.firstYearStart || ""} onChange={(event) => setFirstYearStart(event.target.value)} />
            </Field>
            <Button onClick={() => void patch({ enabled: true, firstYearStart: firstYearStart || current.firstYearStart }, "Livestock is on.")}>Turn on</Button>
          </div>
        ) : (
          <p className={ui.muted}>Off. An admin can turn it on.</p>
        )}
      </Card>
      {current.enabled ? (
        <>
          <Card
            title="Reporting basis"
            description={<>The basis of the farm&apos;s financial statements (LV28).{" "}<InfoTip label="Reporting basis">Special purpose (tax basis) statements follow the farm&apos;s own stated policy. General purpose statements (NZ IFRS or PBE Standards) put changes in livestock values through profit or loss, and measure livestock at fair value less costs to sell, which Tohyee doesn&apos;t work out: the tax values need your accountant&apos;s adjustment.</InfoTip></>}
          >
            <div className={ui.choiceList} role="radiogroup" aria-label="Reporting basis">
              {(["special_purpose", "general_purpose"] as const).map((basis) => (
                <label key={basis}>
                  <input
                    type="radio"
                    disabled={!isAdmin}
                    checked={current.reportingBasis === basis}
                    onChange={() => void patch(basis === "general_purpose" ? { reportingBasis: basis, revaluationTarget: "profit_and_loss" } : { reportingBasis: basis }, "Saved.")}
                  />{" "}
                  {basis === "special_purpose" ? "Special purpose (tax basis)" : "General purpose (NZ IFRS or PBE Standards)"}
                </label>
              ))}
            </div>
          </Card>
          <Card title="Herd scheme revaluation" description={<>Where the non-taxable revaluation of opening stock goes (LV12).{" "}<InfoTip label="Herd scheme revaluation">The draft financial statements&apos; livestock note states the choice as the farm&apos;s policy. Under general purpose reporting it&apos;s always profit and loss. A change applies to the next valuation approved; approved years aren&apos;t re-posted.</InfoTip></>}>
            <div className={ui.choiceList} role="radiogroup" aria-label="Herd scheme revaluation">
              {(["profit_and_loss", "reserve"] as const).map((target) => (
                <label key={target}>
                  <input
                    type="radio"
                    disabled={!isAdmin || (target === "reserve" && current.reportingBasis === "general_purpose")}
                    checked={current.revaluationTarget === target}
                    onChange={() => void patch({ revaluationTarget: target }, "Saved.")}
                  />{" "}
                  {target === "profit_and_loss" ? "Profit and loss, as its own non-taxable line" : "An equity reserve"}
                </label>
              ))}
            </div>
            <div className={ui.grid}>
              {(
                [
                  ["asset", "assetAccount", "Livestock on hand"],
                  ["currentAsset", "currentAssetAccount", "Livestock on hand (current, held for sale)"],
                  ["valueChange", "valueChangeAccount", "Change in value"],
                  ["revaluation", "revaluationAccount", "Herd scheme revaluation (profit and loss)"],
                  ["reserve", "reserveAccount", "Revaluation reserve (equity)"],
                  ["rationsIncome", "rationsIncomeAccount", "Owner's rations (income)"],
                  ["drawings", "drawingsAccount", "Owner drawings (equity)"],
                ] as const
              ).map(([role, field, label]) => (
                <Field key={role} label={label}>
                  {isAdmin && accounts.data ? (
                    <AccountSelect accounts={accounts.data.accounts} value={current.accounts[role]?.code ?? ""} onChange={(code) => void patch({ [field]: code }, "Saved.")} />
                  ) : (
                    <span>{current.accounts[role] ? `${current.accounts[role]!.code} ${current.accounts[role]!.name}` : "Not set"}</span>
                  )}
                </Field>
              ))}
            </div>
          </Card>
          <ClassReportingCard organisationId={organisationId} settings={current} canEdit={isAdmin} onSaved={settings.reload} />
          <OpeningsCard organisationId={organisationId} canEdit={isAdmin} />
          <ElectionsCard organisationId={organisationId} canEdit={isAdmin} />
          <RatesCard organisationId={organisationId} canEdit={isAdmin} />
          <HighPricedCard organisationId={organisationId} canEdit={isAdmin} />
          <LocationsCard organisationId={organisationId} canEdit={can("bookkeeper")} />
        </>
      ) : null}
    </>
  );
}

/** Current or non-current, per class (LV27). */
function ClassReportingCard({ organisationId, settings, canEdit, onSaved }: { organisationId: string; settings: LivestockSettings; canEdit: boolean; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<LivestockKind>(LIVESTOCK_KINDS[0]);
  async function toggle(classCode: string, isCurrent: boolean) {
    setError(null);
    try {
      await api("/api/livestock/class-reporting", { method: "PUT", body: { organisationId, lines: [{ kind, classCode, current: isCurrent }] } });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Card
      title="Current or non-current"
      description={<>Choose for each class whether it&apos;s current or non-current.{" "}<InfoTip label="Current or non-current">Stock held for sale in the normal operating cycle is a current asset; a breeding or milking herd kept is non-current (NZ IAS 1 para 66). The next valuation approved moves the current classes&apos; closing value to the current account; approved years aren&apos;t re-posted.</InfoTip></>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Kind">
        <select value={kind} onChange={(event) => setKind(event.target.value as LivestockKind)}>
          {LIVESTOCK_KINDS.map((entry) => <option key={entry} value={entry}>{KIND_NAMES[entry]}</option>)}
        </select>
      </Field>
      <p>Tick the classes held for sale (current):</p>
      <div className={ui.choiceList}>
        {classesOf(kind).map((entry) => (
          <label key={entry.code}>
            <input type="checkbox" disabled={!canEdit} checked={settings.currentClasses.includes(`${kind}.${entry.code}`)} onChange={(event) => void toggle(entry.code, event.target.checked)} />{" "}
            {entry.name}
          </label>
        ))}
      </div>
    </Card>
  );
}

function OpeningsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const openings = useApiData<{ openings: LivestockOpening[] }>("/api/livestock/openings", { organisationId });
  const [draft, setDraft] = useState<Record<string, { head: string; value: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<LivestockKind[]>([]);
  if (!openings.data) return null;
  // Only the kinds the farm has (or has just added), so the card stays short.
  const shown = LIVESTOCK_KINDS.filter((kind) => added.includes(kind) || openings.data!.openings.some((entry) => entry.kind === kind));
  const addable = LIVESTOCK_KINDS.filter((kind) => !shown.includes(kind));
  const rows = draft ?? Object.fromEntries(openings.data.openings.map((entry) => [`${entry.kind}.${entry.classCode}`, { head: String(entry.head), value: entry.value }]));

  async function save() {
    setError(null);
    try {
      const lines = Object.entries(rows)
        .filter(([, entry]) => entry.head.trim() !== "" && entry.head.trim() !== "0")
        .map(([key, entry]) => {
          const [kind, classCode] = key.split(".");
          return { kind, classCode, head: entry.head, value: entry.value || "0" };
        });
      await api("/api/livestock/openings", { method: "PUT", body: { organisationId, lines } });
      setDraft(null);
      openings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Opening position" description="The first year's opening by class: head and value from last year's workpaper, as at last year's balance date (before ageing). Later years open with the last approved valuation.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {shown.length === 0 ? <Empty>No opening position yet. Add the kinds of livestock the farm had at the start.</Empty> : null}
      {canEdit && addable.length > 0 ? (
        <Field label="Add a kind of livestock">
          <select value="" onChange={(event) => event.target.value && setAdded([...added, event.target.value as LivestockKind])}>
            <option value="">Choose…</option>
            {addable.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_NAMES[kind]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {shown.map((kind) => (
        <div key={kind} className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <caption>{KIND_NAMES[kind]}</caption>
            <thead>
              <tr>
                <th>Class</th>
                <th className={ui.num}>Head</th>
                <th className={ui.num}>Value</th>
              </tr>
            </thead>
            <tbody>
              {classesOf(kind).map((entry) => {
                const key = `${kind}.${entry.code}`;
                const row = rows[key] ?? { head: "", value: "" };
                return (
                  <tr key={key}>
                    <td data-label="Class">{entry.name}</td>
                    <td data-label="Head" className={ui.num}>
                      {canEdit ? (
                        <input aria-label={`${entry.name} head`} inputMode="numeric" size={7} value={row.head} onChange={(event) => setDraft({ ...rows, [key]: { ...row, head: event.target.value } })} />
                      ) : (
                        row.head
                      )}
                    </td>
                    <td data-label="Value" className={ui.num}>
                      {canEdit ? (
                        <input aria-label={`${entry.name} value`} inputMode="decimal" size={12} value={row.value} onChange={(event) => setDraft({ ...rows, [key]: { ...row, value: event.target.value } })} />
                      ) : (
                        <Money value={row.value} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {canEdit && draft ? <Button onClick={() => void save()}>Save opening</Button> : null}
    </Card>
  );
}

function ElectionsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const elections = useApiData<{ elections: Election[] }>("/api/livestock/elections", { organisationId });
  const [form, setForm] = useState({ kind: "dairy_cattle", method: "herd_scheme", fromIncomeYear: "", note: "", herdValueRatio: "", maleBreedingHerdScheme: false });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await api("/api/livestock/elections", {
        method: "POST",
        body: {
          organisationId,
          ...form,
          herdValueRatio: form.method === "herd_scheme" ? form.herdValueRatio || null : null,
          maleBreedingHerdScheme: form.method === "nsc" && form.maleBreedingHerdScheme,
        },
      });
      setForm({ ...form, fromIncomeYear: "", note: "" });
      elections.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Elections" description="Each kind's valuation method from an income year, with the evidence attached. Recording one here files nothing with IRD.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {elections.data && elections.data.elections.length === 0 ? <Empty>No elections recorded.</Empty> : null}
      <ul>
        {elections.data?.elections.map((election) => (
          <li key={election.id}>
            {election.kindName}: {election.methodName}
            {election.herdValueRatio ? ` at ${election.herdValueRatio} x NAMV` : ""}
            {election.maleBreedingHerdScheme ? ", male breeding stock in the herd scheme" : ""} from the {election.fromIncomeYear} income year
            {election.note ? ` (${election.note})` : ""}.{" "}
            <button type="button" className={ui.linkButton} onClick={() => setOpen(open === election.id ? null : election.id)}>
              {open === election.id ? "Hide evidence" : "Evidence"}
            </button>
            {open === election.id ? <RecordExtrasPanel organisationId={organisationId} recordType="livestock_election" recordId={election.id} /> : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Livestock">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              {LIVESTOCK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_NAMES[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Method">
            <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>
              <option value="herd_scheme">Herd scheme</option>
              <option value="nsc">National standard cost</option>
            </select>
          </Field>
          {form.method === "herd_scheme" ? (
            <Field label="Herd value ratio" hint="Needs IRD notice and a valuation at 30 April">
              <select value={form.herdValueRatio} onChange={(event) => setForm({ ...form, herdValueRatio: event.target.value })}>
                <option value="">None (NAMV)</option>
                {["0.9", "1.0", "1.1", "1.2", "1.3"].map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
                {CHATHAM_KINDS.includes(form.kind as LivestockKind) ? <option value="0.3">0.3 (Chatham Islands)</option> : null}
              </select>
            </Field>
          ) : (
            <Field label="Male breeding stock">
              <label>
                <input type="checkbox" checked={form.maleBreedingHerdScheme} onChange={(event) => setForm({ ...form, maleBreedingHerdScheme: event.target.checked })} /> In the herd
                scheme
              </label>
            </Field>
          )}
          <Field label="From income year" hint="2026 = the 2025-26 income year">
            <input inputMode="numeric" size={6} value={form.fromIncomeYear} onChange={(event) => setForm({ ...form, fromIncomeYear: event.target.value })} />
          </Field>
          <Field label="Note">
            <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </Field>
          <Button disabled={form.fromIncomeYear.trim() === ""} onClick={() => void save()}>
            Record election
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function RatesCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const rates = useApiData<{ rates: Rate[] }>("/api/livestock/rates", { organisationId });
  const [form, setForm] = useState({ incomeYear: "", rateKind: "namv", kind: "dairy_cattle", category: "ma_cows", amount: "", source: "" });
  const [error, setError] = useState<string | null>(null);
  const years = [...new Set((rates.data?.rates ?? []).map((rate) => rate.incomeYear))];

  async function save() {
    setError(null);
    try {
      await api("/api/livestock/rates", { method: "PUT", body: { organisationId, ...form } });
      setForm({ ...form, amount: "" });
      rates.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const categories =
    form.rateKind === "namv"
      ? classesOf(form.kind as LivestockKind).map((entry) => [entry.code, entry.name] as const)
      : ([
          ["rising_1", "Rising 1 year"],
          ["rising_2", "Rising 2 year"],
          ["rising_3_male", "Rising 3-year male non-breeding"],
          ["purchased_bobby_calves", "Purchased bobby calves"],
        ] as const);

  return (
    <Card title="IRD rates" description="National average market values (herd scheme) and national standard costs, by income year, with where each came from. A year's rates can't change once a valuation using them is approved.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {years.map((year) => (
        <details key={year}>
          <summary>
            {year - 1}-{String(year).slice(2)} income year ({year})
          </summary>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Rate</th>
                  <th>Livestock</th>
                  <th>Class</th>
                  <th className={ui.num}>Per head</th>
                </tr>
              </thead>
              <tbody>
                {rates.data!.rates
                  .filter((rate) => rate.incomeYear === year)
                  .map((rate) => (
                    <tr key={rate.id} title={rate.source}>
                      <td data-label="Rate">{rate.rateKind === "namv" ? "NAMV" : "NSC"}</td>
                      <td data-label="Livestock">{rate.kindName}</td>
                      <td data-label="Class">{rate.categoryName}</td>
                      <td data-label="Per head" className={ui.num}>
                        <Money value={rate.amount} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className={ui.muted}>Source: {[...new Set(rates.data!.rates.filter((rate) => rate.incomeYear === year).map((rate) => rate.source))].join("; ")}</p>
        </details>
      ))}
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Income year">
            <input inputMode="numeric" size={6} value={form.incomeYear} onChange={(event) => setForm({ ...form, incomeYear: event.target.value })} />
          </Field>
          <Field label="Rate">
            <select
              value={form.rateKind}
              onChange={(event) =>
                setForm({
                  ...form,
                  rateKind: event.target.value,
                  kind: event.target.value === "namv" ? "dairy_cattle" : "dairy_cattle",
                  category: event.target.value === "namv" ? "ma_cows" : "rising_1",
                })
              }
            >
              <option value="namv">NAMV</option>
              <option value="nsc">NSC</option>
            </select>
          </Field>
          <Field label="Livestock">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value, category: form.rateKind === "namv" ? classesOf(event.target.value as LivestockKind)[0].code : form.category })}>
              {form.rateKind === "namv"
                ? LIVESTOCK_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_NAMES[kind]}
                    </option>
                  ))
                : Object.entries(NSC_KIND_NAMES).map(([kind, name]) => (
                    <option key={kind} value={kind}>
                      {name}
                    </option>
                  ))}
            </select>
          </Field>
          <Field label="Class">
            <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {categories.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Per head">
            <input inputMode="decimal" size={9} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
          </Field>
          <Field label="Source" hint="The determination and its link">
            <input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} />
          </Field>
          <Button disabled={!form.incomeYear || !form.amount || !form.source} onClick={() => void save()}>
            Save rate
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function LocationsCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const locations = useApiData<{ locations: LivestockLocation[] }>("/api/livestock/locations", { organisationId });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      await api("/api/livestock/locations", { method: "POST", body: { organisationId, name } });
      setName("");
      locations.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function archive(location: LivestockLocation) {
    try {
      await api(`/api/livestock/locations/${location.id}`, { method: "PATCH", body: { organisationId, archived: !location.archived } });
      locations.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Locations" description="Farms, blocks and grazing places. Moving stock between them doesn't change the head count.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul>
        {locations.data?.locations.map((location) => (
          <li key={location.id}>
            {location.name} {location.archived ? <Badge tone="neutral">Archived</Badge> : null}{" "}
            {canEdit ? (
              <button type="button" className={ui.linkButton} onClick={() => void archive(location)}>
                {location.archived ? "Restore" : "Archive"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="New location">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button disabled={name.trim() === ""} onClick={() => void add()}>
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
