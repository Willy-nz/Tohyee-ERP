"use client";

import { InfoTip } from "@/components/info-tip";
import { DateInput } from "@/components/date-input";
import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { classesOf,KIND_NAMES,LIVESTOCK_KINDS,type LivestockKind } from "@/lib/livestock/classes";
import type { HighPricedAnimal } from "@/lib/livestock/high-priced";
import type { ManagementReport,ManagementValue } from "@/lib/livestock/management";
import { NotOn,Steps,YearPicker,defaultYear,useLivestockSettings,yearEnds } from "@/components/livestock/shared";

// Management values ---------------------------------------------------------------------

export function LivestockManagement({ organisationId }: { organisationId: string }) {
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
      <Steps current="management" />
      <div className={ui.toolbar}>
        <YearPicker years={years} value={yearEnd} onChange={setChosen} />
      </div>
      <ManagementView key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} />
    </>
  );
}

function ManagementView({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const { can } = useWorkspace();
  const report = useApiData<{ report: ManagementReport }>("/api/livestock/management", { organisationId, yearEnd });
  const values = useApiData<{ values: ManagementValue[] }>("/api/livestock/management/values", { organisationId });
  const [month, setMonth] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (report.error) return <Notice tone="error">{report.error}</Notice>;
  if (!report.data) return <p className={ui.muted}>Loading…</p>;
  const data = report.data.report;
  const effective = month || data.yearStart;

  async function save() {
    setError(null);
    try {
      const lines = Object.entries(draft).map(([key, amount]) => {
        const [kind, classCode] = key.split(".");
        return { kind, classCode, amount: amount.trim() === "" ? null : amount };
      });
      await api("/api/livestock/management/values", { method: "PUT", body: { organisationId, effectiveMonth: effective, lines } });
      setDraft({});
      report.reload();
      values.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const kinds = LIVESTOCK_KINDS.filter((kind) => data.months.some((entry) => entry.classes.some((row) => row.kind === kind)) || values.data?.values.some((value) => value.kind === kind));
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice tone="info">The farm&apos;s own values per head, for monthly reporting. They never change tax values, elections or an approved valuation, and post nothing.</Notice>
      {data.missingValues.length > 0 ? (
        <Notice tone="warning">No value per head yet for {data.missingValues.map((entry) => entry.className.toLowerCase()).join(", ")}; they count as 0.00 until one is set.</Notice>
      ) : null}
      <Card title="Stock on hand by month" description={`At the farm's values. Opening (${formatDate(data.opening.monthEnd)}): ${data.opening.head} head, ${data.opening.value}. Each month's change is split into head (at last month's values) and price.`}>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Month end</th>
                <th className={ui.num}>Head</th>
                <th className={ui.num}>Value</th>
                <th className={ui.num}>Change</th>
                <th className={ui.num}>From head</th>
                <th className={ui.num}>From price</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((entry) => (
                <tr key={entry.monthEnd}>
                  <td data-label="Month end">{formatDate(entry.monthEnd)}</td>
                  <td data-label="Head" className={ui.num}>
                    {entry.head}
                  </td>
                  <td data-label="Value" className={ui.num}>
                    <Money value={entry.value} />
                  </td>
                  <td data-label="Change" className={ui.num}>
                    <Money value={entry.change} blankZero />
                  </td>
                  <td data-label="From head" className={ui.num}>
                    <Money value={entry.quantityChange} blankZero />
                  </td>
                  <td data-label="From price" className={ui.num}>
                    <Money value={entry.priceChange} blankZero />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Values per head" description="One value for the whole year is one value from its first month. A later month's value applies from then on.">
        {values.data && values.data.values.length > 0 ? (
          <ul>
            {values.data.values.map((value) => (
              <li key={`${value.kind}.${value.classCode}.${value.effectiveMonth}`}>
                From {formatDate(value.effectiveMonth)}: {KIND_NAMES[value.kind]}, {value.className.toLowerCase()} <Money value={value.amount} />
              </li>
            ))}
          </ul>
        ) : null}
        {can("bookkeeper") ? (
          <>
            <Field label="From month">
              <DateInput value={effective} onChange={(event) => setMonth(event.target.value)} />
            </Field>
            {(kinds.length ? kinds : LIVESTOCK_KINDS).map((kind) => (
              <div key={kind} className={ui.grid}>
                {classesOf(kind).map((entry) => {
                  const key = `${kind}.${entry.code}`;
                  return (
                    <Field key={key} label={`${KIND_NAMES[kind]}: ${entry.name}`}>
                      <input inputMode="decimal" value={draft[key] ?? ""} placeholder="Per head" onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                    </Field>
                  );
                })}
              </div>
            ))}
            <Button disabled={Object.keys(draft).length === 0} onClick={() => void save()}>
              Save values
            </Button>
          </>
        ) : null}
      </Card>
    </>
  );
}

export function HighPricedCard({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const animals = useApiData<{ animals: HighPricedAnimal[] }>("/api/livestock/high-priced", { organisationId });
  const [form, setForm] = useState({ kind: "beef_cattle" as LivestockKind, classCode: "breeding_bulls", description: "", boughtOn: "", cost: "", ratePercent: "", rateSource: "", priorYearNamv: "" });
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await api("/api/livestock/high-priced", { method: "POST", body: { organisationId, ...form, priorYearNamv: form.priorYearNamv || null } });
      setForm({ ...form, description: "", cost: "" });
      animals.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const [leftOn, setLeftOn] = useState("");

  async function left(animal: HighPricedAnimal, how: "sold_or_died" | "stopped_breeding") {
    if (!leftOn) {
      setError("Choose the date it left or stopped breeding first.");
      return;
    }
    try {
      await api(`/api/livestock/high-priced/${animal.id}/left`, { method: "POST", body: { organisationId, leftOn, how } });
      animals.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card
      title="High-priced livestock"
      description={<>An animal that cost at least 500.00 and five times its class&apos;s NAMV is valued on its own.{" "}<InfoTip label="High-priced livestock">It&apos;s valued at cost in the year bought, then less IRD&apos;s depreciation rate each year, until it&apos;s at or below its class&apos;s NAMV. Record its purchase as a movement too. One bought before livestock&apos;s first year opens that year at its value then, apart from its class: keep its head in the class&apos;s opening head, and its value out of the class&apos;s opening value.</InfoTip></>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {animals.data && animals.data.animals.length === 0 ? <Empty>None recorded.</Empty> : null}
      {canEdit && animals.data?.animals.some((animal) => !animal.leftOn) ? (
        <Field label="Date it was sold, died or stopped breeding">
          <DateInput value={leftOn} onChange={(event) => setLeftOn(event.target.value)} />
        </Field>
      ) : null}
      <ul>
        {animals.data?.animals.map((animal) => (
          <li key={animal.id}>
            {animal.description}: {animal.kindName}, {animal.className.toLowerCase()}, bought {formatDate(animal.boughtOn)} for <Money value={animal.cost} />, {animal.ratePercent}% a year (
            {animal.rateSource}){animal.leftOn ? `; ${animal.leftHow === "sold_or_died" ? "sold or died" : "stopped breeding"} ${formatDate(animal.leftOn)}` : ""}.{" "}
            {canEdit && !animal.leftOn ? (
              <>
                <button type="button" className={ui.linkButton} onClick={() => void left(animal, "sold_or_died")}>
                  Sold or died
                </button>{" "}
                <button type="button" className={ui.linkButton} onClick={() => void left(animal, "stopped_breeding")}>
                  Stopped breeding
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={ui.grid}>
          <Field label="Livestock">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as LivestockKind, classCode: classesOf(event.target.value as LivestockKind)[0].code })}>
              {LIVESTOCK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_NAMES[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Class">
            <select value={form.classCode} onChange={(event) => setForm({ ...form, classCode: event.target.value })}>
              {classesOf(form.kind).map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tag or name">
            <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <Field label="Bought on">
            <DateInput value={form.boughtOn} onChange={(event) => setForm({ ...form, boughtOn: event.target.value })} />
          </Field>
          <Field label="Cost excl. GST">
            <input inputMode="decimal" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} />
          </Field>
          <Field label="IRD depreciation rate (%)">
            <input inputMode="decimal" value={form.ratePercent} onChange={(event) => setForm({ ...form, ratePercent: event.target.value })} />
          </Field>
          <Field label="Where the rate came from">
            <input value={form.rateSource} onChange={(event) => setForm({ ...form, rateSource: event.target.value })} />
          </Field>
          <Field label="Last year's NAMV" hint="Only if Tohyee doesn't have it">
            <input inputMode="decimal" value={form.priorYearNamv} onChange={(event) => setForm({ ...form, priorYearNamv: event.target.value })} />
          </Field>
          <Button disabled={!form.description || !form.boughtOn || !form.cost || !form.ratePercent || !form.rateSource} onClick={() => void save()}>
            Record
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
