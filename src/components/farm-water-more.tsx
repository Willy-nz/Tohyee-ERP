"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { WaterPipe } from "@/lib/farming/water";
import { matchPump, MAX_PUMP_POINTS, type MobStock, PEAK_HOURS, STOCK_WATER_CLASSES, stockDemand } from "@/lib/farming/water-demand-rules";
import { KPA_PER_METRE } from "@/lib/farming/water-rules";
import styles from "./farm-water.module.css";

const number = (text: string) => (text.trim() === "" ? Number.NaN : Number(text.replaceAll(",", "")));
const whole = (value: number) => value.toLocaleString("en-NZ", { maximumFractionDigits: 0 });
const fixed = (value: number, places: number) => value.toLocaleString("en-NZ", { minimumFractionDigits: places, maximumFractionDigits: places });

/** What the stock drink in a day, and the flow that has to reach them (FW7). Nothing is saved. */
export function StockWater({ fromMobs, onUse }: { fromMobs: MobStock | null; onUse: (litresAMinute: string) => void }) {
  const mobHead = fromMobs ? fromMobs.classes.reduce((total, each) => total + each.head, 0) : 0;
  const [head, setHead] = useState<Record<string, string>>({});
  const [each, setEach] = useState<Record<string, string>>({});
  const [hours, setHours] = useState(String(PEAK_HOURS));
  const rows = STOCK_WATER_CLASSES.filter((stock) => (head[stock.key] ?? "").trim() !== "").map((stock) => ({ head: number(head[stock.key]), litresEach: each[stock.key] === undefined ? stock.litres : number(each[stock.key]) }));
  const demand = stockDemand(rows, number(hours));
  return (
    <Card title="How much the stock drink" description="Type the head that drink from this line. The litres each are usual allowances: put them up for hot weather or dry feed.">
      {fromMobs && mobHead > 0 ? (
        <>
          <div className={styles.actions}>
            <Button size="small" variant="secondary" onClick={() => setHead(Object.fromEntries(fromMobs.classes.map((each) => [each.key, String(each.head)])))}>
              Fill in from this farm&apos;s mobs ({whole(mobHead)} head)
            </Button>
          </div>
          <p className={ui.muted}>
            A best guess from each mob&apos;s class: cows and ewes are counted as milking, since the line has to cope when they are. Check the head against the stock on this line.
            {fromMobs.leftOutHead > 0 ? ` ${whole(fromMobs.leftOutHead)} head (goats and pigs) have no allowance here and are left out.` : ""}
          </p>
        </>
      ) : null}
      <div className={styles.stock}>
        <div className={styles.stockHead}>
          <span>Stock</span>
          <span>Head</span>
          <span>Litres each</span>
        </div>
        {STOCK_WATER_CLASSES.map((stock) => (
          <div key={stock.key} className={styles.stockRow}>
            <span>{stock.label}</span>
            <input aria-label={`${stock.label}: head`} inputMode="numeric" value={head[stock.key] ?? ""} onChange={(event) => setHead({ ...head, [stock.key]: event.target.value })} />
            <input aria-label={`${stock.label}: litres each a day`} inputMode="decimal" value={each[stock.key] ?? String(stock.litres)} onChange={(event) => setEach({ ...each, [stock.key]: event.target.value })} />
          </div>
        ))}
      </div>
      <Field label="Hours they drink it in" hint={`Stock drink most of a day's water in a few hours. ${PEAK_HOURS} hours is 14 litres a milking cow an hour.`}>
        <input className={styles.small} inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} />
      </Field>
      {rows.length === 0 ? (
        <p className={ui.muted}>Type a head count to see the water.</p>
      ) : !demand ? (
        <p className={ui.muted}>Check the figures: one of them isn&apos;t a number this can use.</p>
      ) : (
        <>
          <dl className={styles.outcome}>
            <div>
              <dt>In a day</dt>
              <dd>{whole(demand.litresPerDay)} litres</dd>
            </div>
            <div>
              <dt>Flow to keep up at the peak</dt>
              <dd>{fixed(demand.peakLpm, 1)} L/min</dd>
            </div>
            <div>
              <dt>Flow if a tank fills all day</dt>
              <dd>{fixed(demand.steadyLpm, 1)} L/min</dd>
            </div>
          </dl>
          <div className={styles.actions}>
            <Button size="small" variant="secondary" onClick={() => onUse(String(demand.peakLpm))}>
              Size a pipe for {fixed(demand.peakLpm, 1)} L/min
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

type Point = { flow: string; head: string };
const REMEMBERED = "tohyee.farmWater.pumpPoints";
const EMPTY: Point[] = [
  { flow: "", head: "" },
  { flow: "", head: "" },
  { flow: "", head: "" },
];

/** Where a pump and a pipe meet (FW8-FW10). The pump's points are remembered on this device only. */
export function PumpMatcher({ pipes, fittings }: { pipes: WaterPipe[]; fittings: number }) {
  const [points, setPoints] = useState<Point[]>(EMPTY);
  const [inside, setInside] = useState("");
  const [length, setLength] = useState("");
  const [rise, setRise] = useState("0");
  const [end, setEnd] = useState("0");
  useEffect(() => {
    try {
      const kept = JSON.parse(window.localStorage.getItem(REMEMBERED) ?? "null") as Point[] | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the device after the page is shown
      if (Array.isArray(kept) && kept.length >= 2 && kept.every((point) => typeof point?.flow === "string" && typeof point?.head === "string")) setPoints(kept.slice(0, MAX_PUMP_POINTS));
    } catch {
      // Nothing remembered, or storage is off: start empty.
    }
  }, []);
  const change = (next: Point[]) => {
    setPoints(next);
    try {
      window.localStorage.setItem(REMEMBERED, JSON.stringify(next));
    } catch {
      // Not remembered this time.
    }
  };
  const typed = points.filter((point) => point.flow.trim() !== "" || point.head.trim() !== "");
  const sizedPipes = pipes.filter((pipe) => pipe.insideMm !== null);
  const ready = typed.length >= 2 && inside.trim() !== "" && length.trim() !== "";
  const match = ready ? matchPump(typed.map((point) => ({ flowLpm: number(point.flow), headM: number(point.head) })), { insideMm: number(inside), lengthM: number(length), riseM: number(rise.trim() === "" ? "0" : rise), endHeadM: number(end.trim() === "" ? "0" : end), fittingsPct: fittings }) : null;
  return (
    <Card title="Match a pump" description="Type a few points from the pump's chart: at each flow, the head it gives. This finds the flow the pump would push through a pipe.">
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.num}>Flow (L/min)</th>
              <th className={ui.num}>Head (m)</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => (
              <tr key={index}>
                <td className={ui.num}>
                  <input className={styles.small} aria-label={`Pump point ${index + 1}: flow`} inputMode="decimal" value={point.flow} onChange={(event) => change(points.map((each, at) => (at === index ? { ...each, flow: event.target.value } : each)))} />
                </td>
                <td className={ui.num}>
                  <input className={styles.small} aria-label={`Pump point ${index + 1}: head`} inputMode="decimal" value={point.head} onChange={(event) => change(points.map((each, at) => (at === index ? { ...each, head: event.target.value } : each)))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.actions}>
        {points.length < MAX_PUMP_POINTS ? (
          <Button size="small" variant="secondary" onClick={() => change([...points, { flow: "", head: "" }])}>
            Add a point
          </Button>
        ) : null}
        {typed.length > 0 ? (
          <Button size="small" variant="secondary" onClick={() => change(EMPTY)}>
            Clear the pump
          </Button>
        ) : null}
      </div>
      <p className={ui.muted}>The pump&apos;s points are remembered on this device only. A chart in kPa: divide by {fixed(KPA_PER_METRE, 1)} for metres.</p>
      {sizedPipes.length > 0 ? (
        <Field label="Fill in from a mapped pipe">
          <select
            value=""
            onChange={(event) => {
              const pipe = sizedPipes.find((each) => each.assetId === event.target.value);
              if (!pipe) return;
              setInside(String(pipe.insideMm));
              setLength(String(pipe.lengthM));
              setRise(String(pipe.riseM ?? 0));
            }}
          >
            <option value="">Choose…</option>
            {sizedPipes.map((pipe) => (
              <option key={pipe.assetId} value={pipe.assetId}>
                {pipe.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={styles.inputs}>
        <Field label="Pipe inside diameter (mm)">
          <input inputMode="decimal" value={inside} onChange={(event) => setInside(event.target.value)} />
        </Field>
        <Field label="Pipe length (metres)">
          <input inputMode="decimal" value={length} onChange={(event) => setLength(event.target.value)} />
        </Field>
        <Field label="Rise from the pump to the far end (metres)" hint="Minus for downhill.">
          <input inputMode="text" value={rise} onChange={(event) => setRise(event.target.value)} />
        </Field>
        <Field label="Pressure wanted at the far end (metres)" hint="What a trough valve or sprinkler needs to work, from its maker. 0 for an open pipe into a tank.">
          <input inputMode="decimal" value={end} onChange={(event) => setEnd(event.target.value)} />
        </Field>
      </div>
      {ready && fittings ? <p className={ui.muted}>Includes {fittings}% on the pipe&apos;s friction for bends and fittings.</p> : null}
      {!ready ? (
        <p className={ui.muted}>Type at least two pump points, and the pipe&apos;s inside diameter and length.</p>
      ) : !match ? (
        <Notice tone="warning">That can&apos;t be worked out. A pump&apos;s head goes down as the flow goes up, each point needs its own flow, and the pipe&apos;s figures have to be ones the sizer accepts.</Notice>
      ) : match.kind === "meets" ? (
        <dl className={styles.outcome}>
          <div>
            <dt>The pump would deliver</dt>
            <dd>{fixed(match.flowLpm, 1)} L/min</dd>
          </div>
          <div>
            <dt>Working at</dt>
            <dd>
              {fixed(match.headM, 1)} m <span className={ui.muted}>({whole(match.headM * KPA_PER_METRE)} kPa)</span>
            </dd>
          </div>
          <div>
            <dt>Speed of the water</dt>
            <dd>
              {fixed(match.velocity, 2)} m/s {match.fast ? <Badge tone="amber">Fast</Badge> : <Badge tone="green">OK</Badge>}
            </dd>
          </div>
        </dl>
      ) : match.kind === "too_small" ? (
        <Notice tone="warning">
          This pump can&apos;t do it. Even at {fixed(match.flowLpm, 0)} L/min, the lowest flow typed, the pipe needs {fixed(match.neededM, 1)} m and the pump gives {fixed(match.pumpHeadM, 1)} m. It may deliver a trickle or nothing: a bigger pipe, a smaller rise or a pump with more head.
        </Notice>
      ) : (
        <Notice tone="info">
          More than {fixed(match.flowLpm, 0)} L/min. At the highest flow typed the pipe needs only {fixed(match.neededM, 1)} m and the pump still gives {fixed(match.pumpHeadM, 1)} m, so the answer is past the end of the points. Add points further along the pump&apos;s chart.
        </Notice>
      )}
    </Card>
  );
}
