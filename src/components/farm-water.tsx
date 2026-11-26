"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { distanceText } from "@/lib/farming/map-assets-rules";
import type { Farm } from "@/lib/farming/paddocks";
import type { FarmWater as Water, WaterPipe } from "@/lib/farming/water";
import {
  FITTINGS_CHOICES,
  FITTINGS_PCT,
  KPA_PER_METRE,
  nominalInsideMm,
  PIPE_OUTSIDE_MM,
  PIPE_SDRS,
  pipeFlow,
  type PipeResult,
  sizeOptions,
  VELOCITY_GUIDE,
} from "@/lib/farming/water-rules";
import { PumpMatcher, StockWater } from "./farm-water-more";
import styles from "./farm-water.module.css";

const FITTINGS_KEPT = "tohyee.farmWater.fittingsPct";
const number = (text: string) =>
  text.trim() === "" ? Number.NaN : Number(text.replaceAll(",", ""));
const fixed = (value: number, places: number) =>
  value.toLocaleString("en-NZ", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });

/** What a pipe does, in words a person can act on. */
function Outcome({ result }: { result: PipeResult }) {
  return (
    <dl className={styles.outcome}>
      <div>
        <dt>Speed of the water</dt>
        <dd>
          {fixed(result.velocity, 2)} m/s{" "}
          {result.fast ? (
            <Badge tone="amber">Fast</Badge>
          ) : (
            <Badge tone="green">OK</Badge>
          )}
        </dd>
      </div>
      <div>
        <dt>Lost to friction</dt>
        <dd>
          {fixed(result.frictionM, 1)} m{" "}
          <span className={ui.muted}>
            ({fixed(result.per100M, 2)} m in each 100 m)
          </span>
        </dd>
      </div>
      <div>
        <dt>
          {result.totalM >= 0
            ? "Pressure needed at the start"
            : "Pressure to spare at the end"}
        </dt>
        <dd>
          {fixed(Math.abs(result.totalM), 1)} m{" "}
          <span className={ui.muted}>
            ({Math.abs(result.totalKpa).toLocaleString("en-NZ")} kPa)
          </span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * Farm › Water (FW1-FW10): what the stock drink, a pipe sizer, a pump
 * matcher, and the farm's mapped water pipes with what each one does once
 * it has a size and a flow.
 */
export function FarmWater({
  organisationId,
  farm,
}: {
  organisationId: string;
  farm: Farm;
}) {
  const loaded = useApiData<{ water: Water }>(
    `/api/farming/farms/${farm.id}/water`,
    { organisationId },
  );
  const canRecord = useCanRecordFarmWork();
  const [sized, setSized] = useState<WaterPipe | null>(null);
  const [flow, setFlow] = useState("");
  const [fittings, setFittings] = useState<number>(FITTINGS_PCT);
  useEffect(() => {
    try {
      const text = window.localStorage.getItem(FITTINGS_KEPT);
      const kept = text === null ? Number.NaN : Number(text);
      const known = (FITTINGS_CHOICES as readonly number[]).includes(kept);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the device after the page is shown
      if (known) setFittings(kept);
    } catch {
      // Nothing remembered: the usual allowance.
    }
  }, []);
  const chooseFittings = (percent: number) => {
    setFittings(percent);
    try {
      window.localStorage.setItem(FITTINGS_KEPT, String(percent));
    } catch {
      // Not remembered this time.
    }
  };
  const water = loaded.data?.water;
  const toSizer = () =>
    document
      .getElementById("size-a-pipe")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className={ui.stack}>
      <Notice tone="info">
        A guide for choosing pipe, not a design. Bends, valves and fittings are
        {fittings
          ? ` allowed for by adding ${fittings}% to the pipe's friction, not counted one by one`
          : " left out"}
        . Check with your supplier before you buy.
      </Notice>
      <StockWater
        fromMobs={water?.stock ?? null}
        onUse={(litresAMinute) => {
          setFlow(litresAMinute);
          toSizer();
        }}
      />
      <div id="size-a-pipe">
        <Sizer
          key={sized?.assetId ?? "free"}
          pipe={sized}
          flow={flow}
          setFlow={setFlow}
          fittings={fittings}
          setFittings={chooseFittings}
        />
      </div>
      <PumpMatcher pipes={water?.pipes ?? []} fittings={fittings} />
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {water ? (
        <Pipes
          fittings={fittings}
          organisationId={organisationId}
          water={water}
          canRecord={canRecord}
          onSize={(pipe) => {
            setSized(pipe);
            if (pipe.flowLpm) setFlow(String(pipe.flowLpm));
            toSizer();
          }}
          onSaved={loaded.reload}
        />
      ) : loaded.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
    </div>
  );
}

/** Works a pipe out as you type. Opened from a mapped pipe, it starts with that pipe's length and figures. */
function Sizer({
  pipe,
  flow,
  setFlow,
  fittings,
  setFittings,
}: {
  pipe: WaterPipe | null;
  flow: string;
  setFlow: (flow: string) => void;
  fittings: number;
  setFittings: (percent: number) => void;
}) {
  const [length, setLength] = useState(pipe ? String(pipe.lengthM) : "");
  const [rise, setRise] = useState(pipe?.riseM ? String(pipe.riseM) : "0");
  const [sdr, setSdr] = useState<number>(PIPE_SDRS[0].sdr);
  const [inside, setInside] = useState(
    pipe?.insideMm ? String(pipe.insideMm) : "",
  );
  const job = {
    flowLpm: number(flow),
    lengthM: number(length),
    riseM: number(rise),
    fittingsPct: fittings,
  };
  const { options, suggested } = sizeOptions(job, sdr);
  const own = inside.trim()
    ? pipeFlow({ ...job, insideMm: number(inside) })
    : null;
  const [all, setAll] = useState(false);
  // On a phone every size is a long list: show the ones either side of the suggestion until asked for the rest.
  const shown = options.filter((option) => option.result.velocity <= 6);
  const at = shown.findIndex((option) => option.outsideMm === suggested);
  const near = all || at < 0 ? shown : shown.slice(Math.max(0, at - 1), at + 3);
  const ready =
    Number.isFinite(job.flowLpm) &&
    Number.isFinite(job.lengthM) &&
    job.flowLpm > 0 &&
    job.lengthM > 0;
  return (
    <Card
      title={pipe ? `Size a pipe: ${pipe.name}` : "Size a pipe"}
      description="Give the flow, the length and the rise. Every size is worked out as you type."
    >
      <div className={styles.inputs}>
        <Field label="Flow (litres a minute)">
          <input
            inputMode="decimal"
            value={flow}
            onChange={(event) => setFlow(event.target.value)}
            placeholder="110"
          />
        </Field>
        <Field label="Length (metres)">
          <input
            inputMode="decimal"
            value={length}
            onChange={(event) => setLength(event.target.value)}
            placeholder="450"
          />
        </Field>
        <Field
          label="Rise to the far end (metres)"
          hint="Uphill is a plus. Downhill is a minus, like -12."
        >
          <input
            inputMode="text"
            value={rise}
            onChange={(event) => setRise(event.target.value)}
          />
        </Field>
        <Field
          label="Wall"
          hint="Polyethylene pipe: a thicker wall takes more pressure and has a smaller hole."
        >
          <select
            value={sdr}
            onChange={(event) => setSdr(Number(event.target.value))}
          >
            {PIPE_SDRS.map((each) => (
              <option key={each.sdr} value={each.sdr}>
                {each.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Bends and fittings"
          hint="Without a list of them, a usual estimate is a tenth on top of the pipe's friction. Used for everything on this page."
        >
          <select
            value={fittings}
            onChange={(event) => setFittings(Number(event.target.value))}
          >
            {FITTINGS_CHOICES.map((percent) => (
              <option key={percent} value={percent}>
                {percent ? `Add ${percent}%` : "Leave them out"}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!ready ? (
        <p className={ui.muted}>Type a flow and a length to see the sizes.</p>
      ) : options.length === 0 ? (
        <p className={ui.muted}>
          Those figures are outside what this can work out.
        </p>
      ) : (
        <>
          <p>
            {suggested ? (
              <>
                <strong>{suggested} mm</strong> is the smallest size that keeps
                the water at or under {VELOCITY_GUIDE} m/s. Check the pressure
                it needs against your pump or tank.
              </>
            ) : (
              <>
                No size here carries that much at or under {VELOCITY_GUIDE} m/s.
                It may need a bigger main or two lines.
              </>
            )}
          </p>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Pipe (outside)</th>
                  <th className={ui.num}>Hole</th>
                  <th className={ui.num}>Speed</th>
                  <th className={ui.num}>Friction</th>
                  <th className={ui.num}>Pressure needed</th>
                </tr>
              </thead>
              <tbody>
                {near.map((option) => (
                  <tr
                    key={option.outsideMm}
                    className={
                      option.outsideMm === suggested
                        ? styles.suggested
                        : undefined
                    }
                  >
                    <td data-label="Pipe (outside)">
                      {option.outsideMm} mm{" "}
                      {option.outsideMm === suggested ? (
                        <Badge tone="green">Suggested</Badge>
                      ) : null}
                    </td>
                    <td data-label="Hole" className={ui.num}>
                      {fixed(option.insideMm, 1)} mm
                    </td>
                    <td data-label="Speed" className={ui.num}>
                      {fixed(option.result.velocity, 2)} m/s{" "}
                      {option.result.fast ? (
                        <Badge tone="amber">Fast</Badge>
                      ) : null}
                    </td>
                    <td data-label="Friction" className={ui.num}>
                      {fixed(option.result.frictionM, 1)} m
                    </td>
                    <td data-label="Pressure needed" className={ui.num}>
                      {option.result.totalM >= 0
                        ? `${fixed(option.result.totalM, 1)} m (${option.result.totalKpa.toLocaleString("en-NZ")} kPa)`
                        : `None: ${fixed(-option.result.totalM, 1)} m to spare`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {near.length < shown.length ? (
            <div className={styles.actions}>
              <Button
                size="small"
                variant="secondary"
                onClick={() => setAll(true)}
              >
                Show all {shown.length} sizes
              </Button>
            </div>
          ) : null}
          <p className={ui.muted}>
            The hole is worked out from the outside size and the wall, so
            it&apos;s close but not exact. One metre of pressure is{" "}
            {fixed(KPA_PER_METRE, 1)} kPa. Sizes where the water would go faster
            than 6 m/s are left out.
          </p>
        </>
      )}
      <Field
        label="Or your pipe's own inside diameter (mm)"
        hint="From the maker's table or the pipe itself, for pipe that isn't in the list."
      >
        <input
          inputMode="decimal"
          value={inside}
          onChange={(event) => setInside(event.target.value)}
          placeholder="40.8"
        />
      </Field>
      {inside.trim() && ready ? (
        own ? (
          <Outcome result={own} />
        ) : (
          <p className={ui.muted}>
            That inside diameter is outside what this can work out.
          </p>
        )
      ) : null}
    </Card>
  );
}

/** The farm's mapped water pipes. Each can be given a size and a flow, and then shows what it does. */
function Pipes({
  fittings,
  organisationId,
  water,
  canRecord,
  onSize,
  onSaved,
}: {
  fittings: number;
  organisationId: string;
  water: Water;
  canRecord: boolean;
  onSize: (pipe: WaterPipe) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Worked out here, as the server does, so the page's allowance for fittings applies.
  const worked = (pipe: WaterPipe) =>
    pipe.insideMm !== null && pipe.flowLpm !== null
      ? pipeFlow({
          insideMm: pipe.insideMm,
          flowLpm: pipe.flowLpm,
          lengthM: pipe.lengthM,
          riseM: pipe.riseM ?? 0,
          fittingsPct: fittings,
        })
      : null;
  const { sizes, unsized } = water.materials;
  const others = [
    [water.counts.troughs, "trough", "troughs"],
    [water.counts.tanks, "tank", "tanks"],
    [water.counts.bores, "bore", "bores"],
    [water.counts.waterPoints, "water point", "water points"],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return (
    <Card
      title="Water pipes on the map"
      description={
        water.pipes.length
          ? `${water.pipes.length} ${water.pipes.length === 1 ? "pipe" : "pipes"}, ${distanceText(water.totalLengthM)} in all${others.length ? `. Also on the map: ${others.join(", ")}.` : "."}`
          : undefined
      }
    >
      {water.pipes.length === 0 ? (
        <p className={ui.muted}>
          No water pipes are drawn yet. Draw them on the{" "}
          <Link href="/operations/farm/map">Map</Link> under Farm assets, and
          they&apos;ll show here with their lengths.
        </p>
      ) : (
        <ul className={styles.pipes}>
          {water.pipes.map((pipe) => (
            <li key={pipe.assetId}>
              <div className={styles.pipeHead}>
                <strong>{pipe.name}</strong>
                <span className={ui.muted}>{distanceText(pipe.lengthM)}</span>
              </div>
              {pipe.insideMm !== null || pipe.flowLpm !== null ? (
                <div className={ui.muted}>
                  {pipe.insideMm !== null
                    ? `${fixed(pipe.insideMm, 1)} mm inside`
                    : "No size yet"}{" "}
                  ·{" "}
                  {pipe.flowLpm !== null
                    ? `${fixed(pipe.flowLpm, 0)} L/min`
                    : "no flow yet"}
                  {pipe.riseM
                    ? ` · ${pipe.riseM > 0 ? "rises" : "falls"} ${fixed(Math.abs(pipe.riseM), 1)} m`
                    : ""}
                </div>
              ) : (
                <div className={ui.muted}>No size or flow yet.</div>
              )}
              {worked(pipe) ? <Outcome result={worked(pipe)!} /> : null}
              {editing === pipe.assetId ? (
                <PipeForm
                  organisationId={organisationId}
                  pipe={pipe}
                  onClose={() => setEditing(null)}
                  onSaved={onSaved}
                />
              ) : (
                <div className={styles.actions}>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => onSize(pipe)}
                  >
                    Try sizes
                  </Button>
                  {canRecord ? (
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => setEditing(pipe.assetId)}
                    >
                      {pipe.insideMm !== null || pipe.flowLpm !== null
                        ? "Change"
                        : "Add its size"}
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {sizes.length > 0 ? (
        <div className={styles.materials}>
          <strong>Pipe by size</strong>
          <ul>
            {sizes.map((size) => (
              <li key={size.insideMm}>
                {fixed(size.insideMm, 1)} mm inside:{" "}
                {distanceText(size.lengthM)}{" "}
                <span className={ui.muted}>
                  ({size.pipes} {size.pipes === 1 ? "pipe" : "pipes"})
                </span>
              </li>
            ))}
            {unsized.pipes > 0 ? (
              <li>
                No size yet: {distanceText(unsized.lengthM)}{" "}
                <span className={ui.muted}>
                  ({unsized.pipes} {unsized.pipes === 1 ? "pipe" : "pipes"})
                </span>
              </li>
            ) : null}
          </ul>
          <p className={ui.muted}>
            Lengths from the map. Allow more for slope, joins and offcuts.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function PipeForm({
  organisationId,
  pipe,
  onClose,
  onSaved,
}: {
  organisationId: string;
  pipe: WaterPipe;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [inside, setInside] = useState(
    pipe.insideMm !== null ? String(pipe.insideMm) : "",
  );
  const [flow, setFlow] = useState(
    pipe.flowLpm !== null ? String(pipe.flowLpm) : "",
  );
  const [rise, setRise] = useState(
    pipe.riseM !== null ? String(pipe.riseM) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState("");
  const [sdr, setSdr] = useState<number>(PIPE_SDRS[0].sdr);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/water-pipes/${pipe.assetId}`, {
        method: "PUT",
        body: {
          organisationId,
          insideMm: inside.trim(),
          flowLpm: flow.trim(),
          riseM: rise.trim(),
        },
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return (
    <div className={styles.form}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.inputs}>
        <Field label="Inside diameter (mm)">
          <input
            inputMode="decimal"
            value={inside}
            onChange={(event) => setInside(event.target.value)}
          />
        </Field>
        <Field label="Flow it's for (L/min)">
          <input
            inputMode="decimal"
            value={flow}
            onChange={(event) => setFlow(event.target.value)}
          />
        </Field>
        <Field
          label="Rise to the far end (m)"
          hint="Minus for downhill. Empty counts as flat."
        >
          <input
            inputMode="text"
            value={rise}
            onChange={(event) => setRise(event.target.value)}
          />
        </Field>
      </div>
      <div className={styles.inputs}>
        <Field
          label="Don't know the inside? Outside size"
          hint="Works it out from the outside size and the wall."
        >
          <select
            value={outside}
            onChange={(event) => {
              setOutside(event.target.value);
              if (event.target.value)
                setInside(
                  String(nominalInsideMm(Number(event.target.value), sdr)),
                );
            }}
          >
            <option value="">Choose…</option>
            {PIPE_OUTSIDE_MM.map((size) => (
              <option key={size} value={size}>
                {size} mm
              </option>
            ))}
          </select>
        </Field>
        <Field label="Wall">
          <select
            value={sdr}
            onChange={(event) => {
              setSdr(Number(event.target.value));
              if (outside)
                setInside(
                  String(
                    nominalInsideMm(
                      Number(outside),
                      Number(event.target.value),
                    ),
                  ),
                );
            }}
          >
            {PIPE_SDRS.map((each) => (
              <option key={each.sdr} value={each.sdr}>
                {each.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={styles.actions}>
        <Button size="small" disabled={busy} onClick={save}>
          Save
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
