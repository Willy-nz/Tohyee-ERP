"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { FuelUserArt } from "@/components/fuel-user-art";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { FuelLine, FuelQuarter } from "@/lib/farming/fuel-refund";
import { FUEL_USER_KIND_KEYS, FUEL_USER_KINDS, type FuelType, type FuelUserKind, previousQuarterEnd, quarterEnd } from "@/lib/farming/fuel-refund-rules";
import { formatDate, todayInBrowser } from "@/lib/format";
import styles from "./fuel-refund.module.css";

/*
 * The fuel excise refund (FUEL1-FUEL12), in three steps for someone on a
 * phone: check the petrol, split it between what used it, and the tank. The
 * refund sits at the top.
 */

type Send = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => Promise<boolean>;

function quarterLabel(end: string): string {
  const month = { "03-31": "Jan–Mar", "06-30": "Apr–Jun", "09-30": "Jul–Sep", "12-31": "Oct–Dec" }[end.slice(5)];
  return `${month} ${end.slice(0, 4)}`;
}

function recentQuarters(today: string): string[] {
  const list: string[] = [quarterEnd(today)];
  while (list.length < 10) list.push(previousQuarterEnd(list[list.length - 1]));
  return list;
}

function litres(value: string): string {
  return `${Number(value).toLocaleString("en-NZ", { maximumFractionDigits: 2 })} L`;
}

export function FuelRefundView({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const [end, setEnd] = useState(previousQuarterEnd(quarterEnd(today)));
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
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Hero end={end} setEnd={setEnd} today={today} quarter={quarter} />
      {quarter ? (
        <>
          <PetrolStep key={`petrol-${quarter.quarterEnd}`} quarter={quarter} send={send} />
          <UsersStep key={`users-${quarter.quarterEnd}-${quarter.users.map((user) => user.id + user.percent + user.roadLicensed).join()}`} organisationId={organisationId} quarter={quarter} send={send} reload={data.reload} setError={setError} />
          <TankStep key={`tank-${quarter.quarterEnd}-${quarter.opening}-${quarter.closing}`} quarter={quarter} send={send} />
          <Extras quarter={quarter} send={send} organisationId={organisationId} reload={data.reload} setError={setError} />
        </>
      ) : null}
    </div>
  );
}

/** The refund, big, and what's left to do (FUEL7, FUEL9). */
function Hero({ end, setEnd, today, quarter }: { end: string; setEnd: (end: string) => void; today: string; quarter: FuelQuarter | null }) {
  const result = quarter?.result ?? null;
  const needsLines = quarter ? quarter.missingLitres + quarter.unsure.length : 0;
  const shared = result ? Number(result.sharedPercent) : 0;
  const steps = quarter
    ? [
        { done: needsLines === 0 && quarter.petrol.length > 0, text: needsLines ? `Petrol: ${needsLines} line${needsLines === 1 ? " needs" : "s need"} you` : quarter.petrol.length ? "Petrol checked" : "No petrol found yet" },
        { done: shared === 100, text: shared === 100 ? "Split between bikes and machines" : `Split: ${shared.toFixed(0)}% of 100% given out` },
        { done: true, text: quarter.closing !== "0.00" || quarter.openingTyped ? "Tank read" : "Tank: only if you have one" },
      ]
    : [];
  const status = quarter
    ? { not_ended: ["Quarter still going", styles.grey], open: [`Claim by ${formatDate(quarter.dueDate)}`, styles.green], late: ["Late: NZTA takes 10% off", styles.amber], too_old: ["Too old to claim", styles.red] }[quarter.timing]
    : null;
  return (
    <section className={styles.hero}>
      <label className={styles.quarter}>
        <span className={ui.srOnly}>Quarter</span>
        <select value={end} onChange={(event) => setEnd(event.target.value)}>
          {recentQuarters(today).map((value) => (
            <option key={value} value={value}>
              {quarterLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.big}>{result ? <>${Number(result.refund).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</> : "—"}</div>
      <div className={styles.under}>{result ? `back from NZTA for ${litres(result.offRoadLitres)} of off-road petrol` : "Finish the steps below to see your refund"}</div>
      {status ? <span className={`${styles.pill} ${status[1]}`}>{status[0]}</span> : null}
      <ul className={styles.checklist}>
        {steps.map((step) => (
          <li key={step.text} className={step.done ? styles.done : styles.todo}>
            <span aria-hidden="true">{step.done ? "✓" : "•"}</span> {step.text}
          </li>
        ))}
      </ul>
      {result?.problems.map((problem) => (
        <Notice key={problem} tone="error">
          {problem}
        </Notice>
      ))}
    </section>
  );
}

/** Step 1: the petrol, with what needs the farmer first (FUEL2-FUEL4). */
function PetrolStep({ quarter, send }: { quarter: FuelQuarter; send: Send }) {
  const needs = [...quarter.unsure, ...quarter.petrol.filter((line) => line.litres === null)];
  const fine = quarter.petrol.filter((line) => line.litres !== null);
  const total = fine.reduce((sum, line) => sum + Number(line.litres), 0);
  return (
    <section className={styles.step}>
      <h2>
        <span className={styles.number}>1</span> Petrol bought
      </h2>
      <p className={styles.summary}>{fine.length ? `${litres(String(total))} from ${fine.length} bill${fine.length === 1 ? "" : "s"}` : "None found in the books for this quarter."}</p>
      {needs.length ? (
        <div className={styles.needs}>
          <p>
            <strong>Tell Tohyee about {needs.length === 1 ? "this one" : `these ${needs.length}`}:</strong>
          </p>
          {needs.map((line) => (
            <NeedRow key={`${line.source}-${line.sourceId}`} line={line} send={send} />
          ))}
        </div>
      ) : null}
      {fine.length ? (
        <details className={styles.more}>
          <summary>See the petrol bills</summary>
          <ul className={styles.lines}>
            {fine.map((line) => (
              <FineRow key={`${line.source}-${line.sourceId}`} line={line} send={send} />
            ))}
          </ul>
        </details>
      ) : null}
      <AddByHand quarter={quarter} send={send} />
    </section>
  );
}

function lineText(line: FuelLine) {
  return (
    <>
      <strong>{formatDate(line.date)}</strong> {line.supplier ? `${line.supplier}: ` : ""}
      {line.description} {line.amount ? <Money value={line.amount} /> : null}
    </>
  );
}

/** A line that needs the farmer: big buttons, then litres if it's petrol (FUEL2, FUEL3). */
function NeedRow({ line, send }: { line: FuelLine; send: Send }) {
  const [typed, setTyped] = useState(line.litresTyped && line.litres ? line.litres : "");
  const choose = (fuelType: FuelType, value = typed) => void send("/api/farming/fuel-refund/lines", "POST", { source: line.source, sourceId: line.sourceId, fuelType, litres: value || null });
  return (
    <div className={styles.need}>
      <div>{lineText(line)}</div>
      {line.fuelType === "petrol" ? (
        <div className={styles.litresRow}>
          <Field label="How many litres of petrol?">
            <input inputMode="decimal" value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
          <Button disabled={!/^\d+(\.\d{1,2})?$/.test(typed)} onClick={() => choose("petrol")}>
            Save
          </Button>
        </div>
      ) : (
        <>
          <p className={styles.ask}>Is this petrol? If it&apos;s both, choose Petrol and type just the petrol litres.</p>
          <div className={styles.choices}>
            <button type="button" onClick={() => choose("petrol")}>
              Petrol
            </button>
            <button type="button" onClick={() => choose("diesel")}>
              Diesel
            </button>
            <button type="button" onClick={() => choose("not_fuel")}>
              Not fuel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FineRow({ line, send }: { line: FuelLine; send: Send }) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState(line.litres ?? "");
  const choose = (fuelType: FuelType, value: string | null = null) => void send("/api/farming/fuel-refund/lines", "POST", { source: line.source, sourceId: line.sourceId, fuelType, litres: value });
  return (
    <li>
      <div>{lineText(line)}</div>
      <div className={styles.lineMeta}>
        {litres(line.litres ?? "0")}
        {line.source === "manual" ? " · added by hand" : line.litresTyped ? " · typed" : " · read from the bill"}
        {line.source !== "manual" && !editing ? (
          <button type="button" className={styles.link} onClick={() => setEditing(true)}>
            Change
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className={styles.litresRow}>
          <Field label="Litres of petrol">
            <input inputMode="decimal" value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
          <Button variant="secondary" onClick={() => choose("petrol", typed || null)}>
            Save
          </Button>
          <Button variant="secondary" onClick={() => choose("diesel")}>
            It&apos;s diesel
          </Button>
          <Button variant="secondary" onClick={() => choose("not_fuel")}>
            Not fuel
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function AddByHand({ quarter, send }: { quarter: FuelQuarter; send: Send }) {
  const [form, setForm] = useState({ boughtOn: quarter.start, description: "", fuelType: "petrol" as "petrol" | "diesel", litres: "" });
  return (
    <details className={styles.more}>
      <summary>Add petrol that isn&apos;t in the books</summary>
      <p className={ui.muted}>From a fuel card statement, or bought yourself for the farm.</p>
      <form
        className={ui.stack}
        onSubmit={(event) => {
          event.preventDefault();
          void send("/api/farming/fuel-refund/manual", "POST", form).then((ok) => ok && setForm({ ...form, description: "", litres: "" }));
        }}
      >
        <Field label="What was it?">
          <input value={form.description} maxLength={200} placeholder="Fuel card, September" onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <div className={styles.litresRow}>
          <Field label="Litres">
            <input inputMode="decimal" value={form.litres} onChange={(event) => setForm({ ...form, litres: event.target.value })} />
          </Field>
          <Field label="Date">
            <DateInput value={form.boughtOn} onChange={(event) => setForm({ ...form, boughtOn: event.target.value })} />
          </Field>
        </div>
        <Button type="submit" disabled={!form.description.trim() || !form.litres}>
          Add petrol
        </Button>
      </form>
    </details>
  );
}

/** Step 2: who used the petrol, with sliders (FUEL6). */
function UsersStep({ organisationId, quarter, send, reload, setError }: { organisationId: string; quarter: FuelQuarter; send: Send; reload: () => void; setError: (error: string | null) => void }) {
  const [shares, setShares] = useState<Record<string, number>>(Object.fromEntries(quarter.users.map((user) => [user.id, Number(user.percent)])));
  const [adding, setAdding] = useState(false);
  const total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  const changed = quarter.users.some((user) => Number(user.percent) !== (shares[user.id] ?? 0));
  const saveUser = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api("/api/farming/fuel-refund/users", { method: "POST", body: { organisationId, ...body } });
      reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    }
  };
  return (
    <section className={styles.step}>
      <h2>
        <span className={styles.number}>2</span> Who used the petrol?
      </h2>
      <p className={styles.summary}>Slide each one to roughly how much of the petrol it used. Road vehicles aren&apos;t refunded.</p>
      <div className={styles.users}>
        {quarter.users.map((user) => (
          <div key={user.id} className={`${styles.user} ${user.roadLicensed ? styles.road : ""}`}>
            <FuelUserArt kind={user.kind} />
            <div className={styles.userBody}>
              <div className={styles.userName}>
                {user.name}
                <span className={styles.percent}>{(shares[user.id] ?? 0).toFixed(0)}%</span>
              </div>
              <input type="range" min={0} max={100} step={5} aria-label={`${user.name}'s share of the petrol`} value={shares[user.id] ?? 0} onChange={(event) => setShares({ ...shares, [user.id]: Number(event.target.value) })} />
              <label className={styles.roadToggle}>
                <input type="checkbox" checked={user.roadLicensed} onChange={(event) => void saveUser({ id: user.id, name: user.name, kind: user.kind, roadLicensed: event.target.checked, active: user.active })} /> Goes on the road (registered for general use)
              </label>
              {user.roadLicensed ? <span className={styles.roadNote}>Not refunded</span> : null}
            </div>
          </div>
        ))}
      </div>
      {quarter.users.length ? (
        <div className={styles.totalRow}>
          <span className={total === 100 ? styles.ok : total > 100 ? styles.over : undefined}>
            {total === 100 ? "✓ " : ""}
            {total}% of the petrol given out{total > 100 ? ": too much" : total < 100 ? `, ${100 - total}% left` : ""}
          </span>
          <Button
            disabled={total > 100 || !changed}
            onClick={() => void send("/api/farming/fuel-refund", "PUT", { opening: quarter.openingTyped ? quarter.opening : null, closing: quarter.closing === "0.00" ? null : quarter.closing, shares: quarter.users.map((user) => ({ userId: user.id, percent: String(shares[user.id] ?? 0) })) })}
          >
            Save split
          </Button>
        </div>
      ) : (
        <p>Add your quad bikes, farm bikes and machines first.</p>
      )}
      {adding ? (
        <AddUser onAdd={(name, kind) => void saveUser({ name, kind }).then((ok) => ok && setAdding(false))} onCancel={() => setAdding(false)} />
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          + Add a bike, vehicle or machine
        </Button>
      )}
    </section>
  );
}

function AddUser({ onAdd, onCancel }: { onAdd: (name: string, kind: FuelUserKind) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<FuelUserKind | null>(null);
  const [name, setName] = useState("");
  return (
    <div className={styles.adder}>
      <p>
        <strong>What is it?</strong>
      </p>
      <div className={styles.kinds}>
        {FUEL_USER_KIND_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={kind === key ? styles.picked : undefined}
            aria-pressed={kind === key}
            onClick={() => {
              setKind(key);
              if (!name) setName(FUEL_USER_KINDS[key]);
            }}
          >
            <FuelUserArt kind={key} size={44} />
            <span>{FUEL_USER_KINDS[key]}</span>
          </button>
        ))}
      </div>
      {kind ? (
        <div className={styles.litresRow}>
          <Field label="Name it" hint="So you can tell them apart, like Red quad.">
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button disabled={!name.trim()} onClick={() => onAdd(name.trim(), kind)}>
            Add
          </Button>
        </div>
      ) : null}
      <button type="button" className={styles.link} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Step 3: the tank, only if there is one (FUEL5). */
function TankStep({ quarter, send }: { quarter: FuelQuarter; send: Send }) {
  const has = quarter.openingTyped || quarter.closing !== "0.00" || quarter.opening !== "0.00";
  const [open, setOpen] = useState(has);
  const [opening, setOpening] = useState(quarter.openingTyped ? quarter.opening : "");
  const [closing, setClosing] = useState(quarter.closing === "0.00" ? "" : quarter.closing);
  return (
    <section className={styles.step}>
      <h2>
        <span className={styles.number}>3</span> Petrol tank
      </h2>
      {!open ? (
        <div className={styles.choices}>
          <button type="button" onClick={() => setOpen(true)}>
            I have a petrol tank
          </button>
          <span className={ui.muted}>No tank? Skip this.</span>
        </div>
      ) : (
        <>
          <p className={styles.summary}>Read the tank on the last day of the quarter.</p>
          <div className={styles.litresRow}>
            <Field label="Litres at the start" hint={quarter.openingTyped ? undefined : `Last quarter's reading: ${litres(quarter.opening)}`}>
              <input inputMode="decimal" value={opening} placeholder={quarter.opening} onChange={(event) => setOpening(event.target.value)} />
            </Field>
            <Field label="Litres at the end">
              <input inputMode="decimal" value={closing} onChange={(event) => setClosing(event.target.value)} />
            </Field>
          </div>
          <Button variant="secondary" onClick={() => void send("/api/farming/fuel-refund", "PUT", { opening: opening || null, closing: closing || null })}>
            Save tank
          </Button>
          {quarter.result ? <p className={ui.muted}>Petrol used this quarter: {litres(quarter.result.used)}</p> : null}
        </>
      )}
    </section>
  );
}

/** Folded away: how to claim, diesel, not fuel, added by hand (FUEL8, FUEL10, FUEL11). */
function Extras({ quarter, send, organisationId, reload, setError }: { quarter: FuelQuarter; send: Send; organisationId: string; reload: () => void; setError: (error: string | null) => void }) {
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
  const result = quarter.result;
  const notes = [...(result?.notes ?? []), ...quarter.notes.filter((note) => !note.startsWith("NZTA needs you registered"))];
  return (
    <section className={styles.step}>
      <details className={styles.more}>
        <summary>How to claim</summary>
        <ol className={styles.howTo}>
          <li>Register with NZTA for fuel excise refunds (once).</li>
          <li>Fill in NZTA&apos;s MR70 form with the off-road litres, and email it with your fuel receipts to fed@nzta.govt.nz.</li>
          <li>
            When the money comes in, code it back to your fuel account with GST at 15%.
            {result ? (
              <>
                {" "}
                <Money value={result.gst} /> of it is GST.
              </>
            ) : null}
          </li>
        </ol>
        <p className={ui.muted}>Petrol is refunded at 80.5276c a litre: excise duty plus GST. Diesel isn&apos;t refunded.</p>
        {notes.map((note) => (
          <Notice key={note} tone="info">
            {note}
          </Notice>
        ))}
      </details>
      <details className={styles.more}>
        <summary>Diesel ({litres(quarter.dieselLitres)}, not refunded)</summary>
        <ul className={styles.lines}>
          {quarter.diesel.map((line) => (
            <li key={`${line.source}-${line.sourceId}`}>
              <div>{lineText(line)}</div>
              {line.source !== "manual" ? (
                <button type="button" className={styles.link} onClick={() => void send("/api/farming/fuel-refund/lines", "POST", { source: line.source, sourceId: line.sourceId, fuelType: "unsure" })}>
                  Not diesel?
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
      {quarter.notFuel.length ? (
        <details className={styles.more}>
          <summary>Marked not fuel ({quarter.notFuel.length})</summary>
          <ul className={styles.lines}>
            {quarter.notFuel.map((line) => (
              <li key={`${line.source}-${line.sourceId}`}>
                <div>{lineText(line)}</div>
                <button type="button" className={styles.link} onClick={() => void send("/api/farming/fuel-refund/lines", "POST", { source: line.source, sourceId: line.sourceId, fuelType: "unsure" })}>
                  It is fuel
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {manual.length ? (
        <details className={styles.more}>
          <summary>Added by hand ({manual.length})</summary>
          <ul className={styles.lines}>
            {manual.map((line) => (
              <li key={line.sourceId}>
                {formatDate(line.date)}: {line.description}, {litres(line.litres ?? "0")}{" "}
                <button type="button" className={styles.link} onClick={() => void remove(line.sourceId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
