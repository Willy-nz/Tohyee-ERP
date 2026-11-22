"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge,Button,Card,Empty,Field,Notice,Stat,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { KIND_NAMES,LIVESTOCK_KINDS } from "@/lib/livestock/classes";
import type { AgeingPreview,HeadCount } from "@/lib/livestock/movements";
import { NotOn,Steps,YearPicker,defaultYear,useLivestockSettings,yearEnds } from "@/components/livestock/shared";

// Overview: head count -----------------------------------------------------------

type HeadRow = HeadCount["rows"][number];
const signed = (value: number) => (value === 0 ? "" : value > 0 ? `+${value}` : String(value));
const out = (value: number) => (value ? `(${value})` : "");
/** The movements between opening and closing, in the order of the sum. */
const MOVEMENT_COLUMNS: Array<{ label: string; text: (row: HeadRow) => string }> = [
  { label: "Ageing", text: (row) => signed(row.ageingIn - row.ageingOut) },
  { label: "Born", text: (row) => (row.births ? String(row.births) : "") },
  { label: "Bought", text: (row) => (row.bought ? String(row.bought) : "") },
  { label: "Sold", text: (row) => out(row.sold) },
  { label: "Died", text: (row) => out(row.died) },
  { label: "Rations", text: (row) => out(row.rations) },
  { label: "Missing / found", text: (row) => signed(row.found - row.missing) },
  { label: "Class changes", text: (row) => signed(row.reclassIn - row.reclassOut) },
];

export function LivestockOverview({ organisationId }: { organisationId: string }) {
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
      <Steps current="overview" />
      <div className={ui.toolbar}>
        <YearPicker years={years} value={yearEnd} onChange={setChosen} />
      </div>
      <HeadCountView key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} />
    </>
  );
}

function HeadCountView({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const { can } = useWorkspace();
  const result = useApiData<{ headCount: HeadCount }>("/api/livestock/head-count", { organisationId, yearEnd });
  const ageing = useApiData<{ ageing: AgeingPreview }>("/api/livestock/ageing", { organisationId, yearEnd });
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [split, setSplit] = useState("");
  const [busy, setBusy] = useState(false);
  if (result.error) return <Notice tone="error">{result.error}</Notice>;
  if (!result.data) return <p className={ui.muted}>Loading…</p>;
  const data = result.data.headCount;

  async function saveCounts() {
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(counts)
        .filter(([, head]) => head.trim() !== "")
        .map(([key, head]) => {
          const [kind, classCode] = key.split(".");
          return { kind, classCode, head };
        });
      await api("/api/livestock/counts", { method: "POST", body: { organisationId, countDate: yearEnd, lines } });
      setCounts({});
      result.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSplit(kind: string, classCode: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/livestock/ageing", { method: "PUT", body: { organisationId, yearEnd, kind, classCode, head: split } });
      setSplit("");
      result.reload();
      ageing.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const kinds = LIVESTOCK_KINDS.filter((kind) => data.rows.some((row) => row.kind === kind));
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data.unexplained.length > 0 ? (
        <Notice tone="warning">
          {data.unexplained.map((entry) => `${entry.className}: ${entry.counted} counted, ${entry.expected} expected (${Math.abs(entry.difference)} not explained).`).join(" ")} Record
          the missing, found or other movements that explain the difference; the year can&apos;t be valued until then.
        </Notice>
      ) : null}
      <div className={ui.statRow}>
        <Stat label="Opening head" value={data.totals.opening.toLocaleString("en-NZ")} />
        <Stat label="Born" value={data.totals.births.toLocaleString("en-NZ")} />
        <Stat label="Bought" value={data.totals.bought.toLocaleString("en-NZ")} />
        <Stat label="Sold" value={data.totals.sold.toLocaleString("en-NZ")} />
        <Stat label="Closing head" value={data.totals.closing.toLocaleString("en-NZ")} />
      </div>
      <Card
        title={`Head count, ${formatDate(data.yearStart)} to ${formatDate(data.yearEnd)}`}
        description={
          <>
            Each class from opening to closing.{" "}
            <InfoTip label="How closing is worked out">
            Opening + born + bought − sold − died − rations − missing + found ± class changes ± ageing = closing. Ageing happens at the start of the year and nets to zero across the herd. A column with
            nothing in it for the year is left out.
          </InfoTip>
          </>
        }
      >
        {data.rows.length === 0 ? (
          <Empty>No stock yet. Set the opening position in Livestock settings, then record movements.</Empty>
        ) : (
          kinds.map((kind) => {
            const rows = data.rows.filter((row) => row.kind === kind);
            // A movement nobody recorded this year isn't a column: the table stays as wide as the year was busy.
            const columns = MOVEMENT_COLUMNS.filter((column) => rows.some((row) => column.text(row) !== ""));
            return (
            <div key={kind} className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <caption>{KIND_NAMES[kind]}</caption>
                <thead>
                  <tr>
                    <th>Class</th>
                    <th className={ui.num}>Opening</th>
                    {columns.map((column) => (
                      <th key={column.label} className={ui.num}>
                        {column.label}
                      </th>
                    ))}
                    <th className={ui.num}>Closing</th>
                    <th className={ui.num}>Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                      const key = `${row.kind}.${row.classCode}`;
                      return (
                        <tr key={key}>
                          <td data-label="Class">{row.className}</td>
                          <td data-label="Opening" className={ui.num}>
                            {row.opening}
                          </td>
                          {columns.map((column) => (
                            <td key={column.label} data-label={column.label} className={ui.num}>
                              {column.text(row)}
                            </td>
                          ))}
                          <td data-label="Closing" className={ui.num}>
                            <strong>{row.closing}</strong>
                          </td>
                          <td data-label="Counted" className={ui.num}>
                            {can("bookkeeper") ? (
                              <input
                                aria-label={`${row.className} counted`}
                                inputMode="numeric"
                                size={6}
                                placeholder={row.counted === null ? "" : String(row.counted)}
                                value={counts[key] ?? ""}
                                onChange={(event) => setCounts({ ...counts, [key]: event.target.value })}
                              />
                            ) : (
                              (row.counted ?? "")
                            )}
                            {row.unexplained ? <Badge tone="amber">{row.unexplained > 0 ? `${row.unexplained} short` : `${-row.unexplained} over`}</Badge> : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            );
          })
        )}
        <p className={ui.muted}>
          Totals: opening {data.totals.opening}, closing {data.totals.closing}. Ageing {data.ageingBalances ? "nets to zero" : "doesn't net to zero"}.
        </p>
        {can("bookkeeper") && Object.values(counts).some((value) => value.trim() !== "") ? (
          <Button disabled={busy} onClick={() => void saveCounts()}>
            Save year-end count
          </Button>
        ) : null}
      </Card>

      <Card title="Ageing at the start of the year" description="Each class's head at the end of last year moves to the next class. It's worked out, so it can't run twice, and a late entry in an earlier year flows through.">
        {ageing.data ? (
          <>
            {ageing.data.ageing.steps.length === 0 && ageing.data.ageing.needsSplit.length === 0 ? <Empty>Nothing to age.</Empty> : null}
            <ul>
              {ageing.data.ageing.steps.map((step) => (
                <li key={`${step.kind}.${step.classCode}`}>
                  {KIND_NAMES[step.kind]}: {step.head} {step.className.toLowerCase()} → {step.toClassName.toLowerCase()}
                </li>
              ))}
            </ul>
            {ageing.data.ageing.needsSplit.map((step) => (
              <div key={step.classCode} className={ui.inlineForm}>
                <Field label={`How many of the ${step.head} ${step.className.toLowerCase()} turned rising five?`}>
                  <input inputMode="numeric" value={split} onChange={(event) => setSplit(event.target.value)} />
                </Field>
                {can("bookkeeper") ? (
                  <Button disabled={busy || split.trim() === ""} onClick={() => void saveSplit(step.kind, step.classCode)}>
                    Save
                  </Button>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </Card>

      {data.held.length > 0 ? (
        <Card title="Held for others" description="Stock on the farm that belongs to someone else. Shown here, never counted as the farm's or valued.">
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Whose</th>
                  <th>Class</th>
                  <th className={ui.num}>Opening</th>
                  <th className={ui.num}>Arrived</th>
                  <th className={ui.num}>Left</th>
                  <th className={ui.num}>Closing</th>
                </tr>
              </thead>
              <tbody>
                {data.held.map((row) => (
                  <tr key={`${row.heldFor}.${row.kind}.${row.classCode}`}>
                    <td data-label="Whose">{row.heldFor}</td>
                    <td data-label="Class">
                      {KIND_NAMES[row.kind]}: {row.className}
                    </td>
                    <td data-label="Opening" className={ui.num}>
                      {row.opening}
                    </td>
                    <td data-label="Arrived" className={ui.num}>
                      {row.arrived}
                    </td>
                    <td data-label="Left" className={ui.num}>
                      {row.left}
                    </td>
                    <td data-label="Closing" className={ui.num}>
                      {row.closing}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {data.byLocation.length > 0 ? (
        <Card title="Where the stock is" description={`At ${formatDate(data.yearEnd)}, by kind. The farm's own stock grazing elsewhere is still counted.`}>
          <ul>
            {data.byLocation.map((row) => (
              <li key={`${row.locationId ?? "none"}.${row.kind}`}>
                {row.locationName}: {row.head} {KIND_NAMES[row.kind].toLowerCase()}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
