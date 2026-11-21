"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { FuelLine, FuelQuarter, FuelUser } from "@/lib/farming/fuel-refund";
import { FUEL_TYPE_LABELS, FUEL_TYPES, FUEL_USER_KIND_KEYS, FUEL_USER_KINDS, type FuelType, type FuelUserKind, PETROL_REFUND_PER_LITRE, previousQuarterEnd, quarterEnd } from "@/lib/farming/fuel-refund-rules";
import { formatDate, todayInBrowser } from "@/lib/format";

/*
 * The fuel excise refund (FUEL1-FUEL12): a quarter's petrol from the books,
 * the tank, each vehicle or machine's share, and the refund for NZTA's MR70.
 */

function lastEndedQuarter(today: string): string {
  return previousQuarterEnd(quarterEnd(today));
}

function quarterLabel(end: string): string {
  const month = { "03-31": "Jan–Mar", "06-30": "Apr–Jun", "09-30": "Jul–Sep", "12-31": "Oct–Dec" }[end.slice(5)];
  return `${month} ${end.slice(0, 4)}`;
}

function recentQuarters(today: string): string[] {
  const list: string[] = [quarterEnd(today)];
  while (list.length < 10) list.push(previousQuarterEnd(list[list.length - 1]));
  return list;
}

export function FuelRefundView({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const [end, setEnd] = useState(lastEndedQuarter(today));
  const data = useApiData<{ quarter: FuelQuarter }>("/api/farming/fuel-refund", { organisationId, quarterEnd: end });
  const quarter = data.data?.quarter ?? null;
  const [error, setError] = useState<string | null>(null);
  const send: Send = async (path, method, body) => {
    setError(null);
    try {
      await api(path, { method, body: { organisationId, quarterEnd: end, ...body } });
      data.reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    }
  };
  return (
    <div className={ui.stack}>
      <div className={ui.inlineForm}>
        <Field label="Quarter">
          <select value={end} onChange={(event) => setEnd(event.target.value)}>
            {recentQuarters(today).map((value) => (
              <option key={value} value={value}>
                {quarterLabel(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {quarter ? (
        <>
          <ResultCard quarter={quarter} />
          <LinesCard title="Petrol" quarter={quarter} lines={quarter.petrol} send={send} />
          <UsersCard key={`${quarter.quarterEnd}-${quarter.users.map((user) => user.id + user.percent).join()}`} organisationId={organisationId} quarter={quarter} send={send} reload={data.reload} />
          <TankCard key={`tank-${quarter.quarterEnd}`} quarter={quarter} send={send} />
          {quarter.unsure.length ? <LinesCard title="Not sure: petrol or diesel?" description="Pick what each one is. If a line has both, mark it petrol and type only the petrol litres." quarter={quarter} lines={quarter.unsure} send={send} /> : null}
          <LinesCard title={`Diesel (${quarter.dieselLitres} L, not refunded)`} quarter={quarter} lines={quarter.diesel} send={send} />
          {quarter.notFuel.length ? <LinesCard title="Marked not fuel" quarter={quarter} lines={quarter.notFuel} send={send} /> : null}
          <ManualCard quarter={quarter} send={send} organisationId={organisationId} reload={data.reload} setError={setError} />
        </>
      ) : null}
    </div>
  );
}

function ResultCard({ quarter }: { quarter: FuelQuarter }) {
  const result = quarter.result;
  const timing = { not_ended: <Badge tone="blue">Quarter not ended</Badge>, open: <Badge tone="green">Due {formatDate(quarter.dueDate)}</Badge>, late: <Badge tone="amber">Late: 10% off</Badge>, too_old: <Badge tone="red">Too old to claim</Badge> }[quarter.timing];
  return (
    <Card title={`Refund for ${quarterLabel(quarter.quarterEnd)}`} description={`Off-road petrol at ${(Number(PETROL_REFUND_PER_LITRE) * 100).toFixed(4)}c a litre (excise duty plus GST). Diesel isn't refunded.`}>
      <div>{timing}</div>
      {quarter.missingLitres ? <Notice tone="warning">{quarter.missingLitres} petrol line{quarter.missingLitres === 1 ? " has" : "s have"} no litres. Type them below to work out the refund.</Notice> : null}
      {result?.problems.map((problem) => (
        <Notice key={problem} tone="error">
          {problem}
        </Notice>
      ))}
      {[...(result?.notes ?? []), ...quarter.notes].map((note) => (
        <Notice key={note} tone="info">
          {note}
        </Notice>
      ))}
      {result ? (
        <table className={ui.table}>
          <tbody>
            <tr>
              <td>Petrol bought</td>
              <td className={ui.num}>{result.bought} L</td>
            </tr>
            <tr>
              <td>Petrol used (with the tank)</td>
              <td className={ui.num}>{result.used} L</td>
            </tr>
            <tr>
              <td>Used off the road ({result.claimedPercent}%)</td>
              <td className={ui.num}>{result.offRoadLitres} L</td>
            </tr>
            <tr>
              <th>Refund to claim</th>
              <th className={ui.num}>
                <Money value={result.refund} />
              </th>
            </tr>
            <tr>
              <td className={ui.muted}>Excise duty / GST in it</td>
              <td className={`${ui.num} ${ui.muted}`}>
                <Money value={result.excise} /> / <Money value={result.gst} />
              </td>
            </tr>
          </tbody>
        </table>
      ) : null}
      <p className={ui.muted}>Claim it on NZTA&apos;s MR70 with the receipts. When the refund comes in, code it back to the fuel account with GST at 15%: the refund includes GST.</p>
    </Card>
  );
}

type Send = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => Promise<boolean>;

function LinesCard({ title, description, quarter, lines, send }: { title: string; description?: string; quarter: FuelQuarter; lines: FuelLine[]; send: Send }) {
  return (
    <Card title={title} description={description}>
      {!lines.length ? <p className={ui.muted}>None in {quarterLabel(quarter.quarterEnd)}.</p> : null}
      <ul className={ui.list}>
        {lines.map((line) => (
          <LineRow key={`${line.source}-${line.sourceId}`} line={line} send={send} />
        ))}
      </ul>
    </Card>
  );
}

function LineRow({ line, send }: { line: FuelLine; send: Send }) {
  const [litres, setLitres] = useState(line.litresTyped ? (line.litres ?? "") : "");
  const save = (fuelType: FuelType, typed: string) => void send("/api/farming/fuel-refund/lines", "POST", { source: line.source, sourceId: line.sourceId, fuelType, litres: typed || null });
  return (
    <li>
      <div>
        <strong>{formatDate(line.date)}</strong> {line.supplier ? `${line.supplier}: ` : ""}
        {line.description} {line.amount ? <Money value={line.amount} /> : null}
        {line.accountName ? <span className={ui.muted}> · {line.accountName}</span> : null}
      </div>
      {line.source === "manual" ? (
        <span className={ui.muted}>
          {line.litres} L, added by hand
        </span>
      ) : (
        <div className={ui.inlineForm}>
          <Field label="Fuel">
            <select value={line.fuelType} onChange={(event) => save(event.target.value as FuelType, litres)}>
              {FUEL_TYPES.map((value) => (
                <option key={value} value={value}>
                  {FUEL_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Litres" hint={line.litresTyped ? "Typed" : line.litres ? `Tohyee read ${line.litres} L` : "Not found: type them"}>
            <input inputMode="decimal" value={litres} placeholder={line.litres ?? ""} onChange={(event) => setLitres(event.target.value)} onBlur={() => litres !== (line.litresTyped ? line.litres : "") && save(line.fuelType, litres)} />
          </Field>
        </div>
      )}
    </li>
  );
}

function UsersCard({ organisationId, quarter, send, reload }: { organisationId: string; quarter: FuelQuarter; send: Send; reload: () => void }) {
  const [shares, setShares] = useState<Record<string, string>>(Object.fromEntries(quarter.users.map((user) => [user.id, user.percent === "0.00" ? "" : user.percent])));
  const [adding, setAdding] = useState({ name: "", kind: "quad" as FuelUserKind });
  const [error, setError] = useState<string | null>(null);
  const total = Object.values(shares).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const saveShares = () => void send("/api/farming/fuel-refund", "PUT", { opening: quarter.openingTyped ? quarter.opening : null, closing: quarter.closing === "0.00" ? null : quarter.closing, shares: quarter.users.map((user) => ({ userId: user.id, percent: shares[user.id] || "0" })) });
  const saveUser = async (body: Partial<FuelUser> & { name: string; kind: FuelUserKind }) => {
    setError(null);
    try {
      await api("/api/farming/fuel-refund/users", { method: "POST", body: { organisationId, ...body } });
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="What uses the petrol" description="Each one's share of the petrol used this quarter, in per cent, from the logbook or tank records. Things licensed for general use on the road (not exempted farm vehicles) aren't claimed.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className={ui.list}>
        {quarter.users.map((user) => (
          <li key={user.id}>
            <div className={ui.inlineForm}>
              <Field label={`${user.name} · ${FUEL_USER_KINDS[user.kind]}`}>
                <input aria-label={`${user.name}'s share in per cent`} inputMode="decimal" size={6} value={shares[user.id] ?? ""} placeholder="0" onChange={(event) => setShares({ ...shares, [user.id]: event.target.value })} />
              </Field>
              <span>%</span>
              {user.roadLicensed ? <Badge tone="amber">Road: not claimed</Badge> : null}
            </div>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={user.roadLicensed} onChange={(event) => void saveUser({ id: user.id, name: user.name, kind: user.kind, roadLicensed: event.target.checked, active: user.active })} /> Licensed for the road
            </label>
          </li>
        ))}
      </ul>
      {quarter.users.length ? <p>Total: <strong>{total.toFixed(2)}%</strong></p> : null}
      {quarter.users.length ? (
        <Button disabled={total > 100} onClick={saveShares}>
          Save shares
        </Button>
      ) : null}
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          void saveUser({ name: adding.name.trim(), kind: adding.kind }).then(() => setAdding({ ...adding, name: "" }));
        }}
      >
        <Field label="Add a bike, vehicle or machine">
          <input value={adding.name} maxLength={100} placeholder="Red quad" onChange={(event) => setAdding({ ...adding, name: event.target.value })} />
        </Field>
        <Field label="Kind">
          <select value={adding.kind} onChange={(event) => setAdding({ ...adding, kind: event.target.value as FuelUserKind })}>
            {FUEL_USER_KIND_KEYS.map((key) => (
              <option key={key} value={key}>
                {FUEL_USER_KINDS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="secondary" disabled={!adding.name.trim()}>
          Add
        </Button>
      </form>
    </Card>
  );
}

function TankCard({ quarter, send }: { quarter: FuelQuarter; send: Send }) {
  const [opening, setOpening] = useState(quarter.openingTyped ? quarter.opening : "");
  const [closing, setClosing] = useState(quarter.closing === "0.00" ? "" : quarter.closing);
  return (
    <Card title="Petrol tank" description="Only if you keep petrol in a bulk tank. Read it on the last day of the quarter.">
      <div className={ui.inlineForm}>
        <Field label="Litres at the start" hint={quarter.openingTyped ? "Typed" : `Last quarter's end: ${quarter.opening} L`}>
          <input inputMode="decimal" value={opening} placeholder={quarter.opening} onChange={(event) => setOpening(event.target.value)} />
        </Field>
        <Field label="Litres at the end">
          <input inputMode="decimal" value={closing} onChange={(event) => setClosing(event.target.value)} />
        </Field>
        <Button variant="secondary" onClick={() => void send("/api/farming/fuel-refund", "PUT", { opening: opening || null, closing: closing || null })}>
          Save tank
        </Button>
      </div>
    </Card>
  );
}

function ManualCard({ quarter, send, organisationId, reload, setError }: { quarter: FuelQuarter; send: Send; organisationId: string; reload: () => void; setError: (error: string | null) => void }) {
  const [form, setForm] = useState({ boughtOn: quarter.start, description: "", fuelType: "petrol" as "petrol" | "diesel", litres: "" });
  const manual = [...quarter.petrol, ...quarter.diesel].filter((line) => line.source === "manual");
  const remove = async (id: string) => {
    setError(null);
    try {
      await api(`/api/farming/fuel-refund/manual/${id}?organisationId=${encodeURIComponent(organisationId)}&quarterEnd=${quarter.quarterEnd}`, { method: "DELETE" });
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="Fuel not in the books" description="Petrol or diesel on a fuel card statement, or bought personally for the farm.">
      <ul className={ui.list}>
        {manual.map((line) => (
          <li key={line.sourceId}>
            {formatDate(line.date)}: {line.description}, {line.litres} L {FUEL_TYPE_LABELS[line.fuelType].toLowerCase()}{" "}
            <Button variant="secondary" onClick={() => void remove(line.sourceId)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          void send("/api/farming/fuel-refund/manual", "POST", form).then((ok) => ok && setForm({ ...form, description: "", litres: "" }));
        }}
      >
        <Field label="Date">
          <DateInput value={form.boughtOn} onChange={(event) => setForm({ ...form, boughtOn: event.target.value })} />
        </Field>
        <Field label="What">
          <input value={form.description} maxLength={200} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <Field label="Fuel">
          <select value={form.fuelType} onChange={(event) => setForm({ ...form, fuelType: event.target.value as "petrol" | "diesel" })}>
            <option value="petrol">Petrol</option>
            <option value="diesel">Diesel</option>
          </select>
        </Field>
        <Field label="Litres">
          <input inputMode="decimal" value={form.litres} onChange={(event) => setForm({ ...form, litres: event.target.value })} />
        </Field>
        <Button type="submit" variant="secondary" disabled={!form.description.trim() || !form.litres}>
          Add
        </Button>
      </form>
    </Card>
  );
}
