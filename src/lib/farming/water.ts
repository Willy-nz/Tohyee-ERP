import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import type { Position } from "@/lib/farming/geometry";
import { lengthMetres } from "@/lib/farming/map-assets-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { MAX_FLOW_LPM, MAX_INSIDE_MM, MAX_RISE_M, MIN_INSIDE_MM, pipeFlow, type PipeResult } from "@/lib/farming/water-rules";
import { requireId } from "@/lib/validation";

/*
 * Farm water (examples FW1-FW6, not yet reviewed): the water pipes drawn on
 * a farm's map, each with its length from the map and, once someone has
 * said, its size, the flow it's meant for and its rise. From those the
 * Water page shows each line's velocity and the pressure it needs.
 */

export type WaterPipe = {
  assetId: string;
  name: string;
  note: string | null;
  /** From the map, to the metre. */
  lengthM: number;
  insideMm: number | null;
  flowLpm: number | null;
  /** How far the far end is above the start, metres; nothing said counts as flat. */
  riseM: number | null;
  /** Worked out when it has a size and a flow. */
  result: PipeResult | null;
};

export type FarmWater = {
  farmId: string;
  pipes: WaterPipe[];
  /** All the pipes' lengths added up, metres. */
  totalLengthM: number;
  /** What else is on the map for water. */
  counts: { troughs: number; tanks: number; bores: number; waterPoints: number };
};

type Row = { id: string; name: string; note: string | null; geometry: { coordinates: Position[] }; pipe_inside_mm: string | null; pipe_flow_lpm: string | null; pipe_rise_m: string | null };

function toPipe(row: Row): WaterPipe {
  const lengthM = Math.round(lengthMetres(row.geometry.coordinates));
  const insideMm = row.pipe_inside_mm === null ? null : Number(row.pipe_inside_mm);
  const flowLpm = row.pipe_flow_lpm === null ? null : Number(row.pipe_flow_lpm);
  const riseM = row.pipe_rise_m === null ? null : Number(row.pipe_rise_m);
  return {
    assetId: row.id,
    name: row.name,
    note: row.note,
    lengthM,
    insideMm,
    flowLpm,
    riseM,
    result: insideMm !== null && flowLpm !== null ? pipeFlow({ insideMm, flowLpm, lengthM, riseM: riseM ?? 0 }) : null,
  };
}

const PIPE_COLUMNS = "a.id::text, a.name, a.note, a.geometry, a.pipe_inside_mm::text, a.pipe_flow_lpm::text, a.pipe_rise_m::text";

/** A farm's mapped water pipes and what each does (FW6). Anyone who can see the farm. */
export async function getFarmWater(tx: OrgTx, farmIdInput: unknown): Promise<FarmWater> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "farmId");
  if (!(await tx.query("select 1 from farms where id = $1", [farmId])).rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  const rows = await tx.query<Row>(`select ${PIPE_COLUMNS} from farm_map_assets a where a.farm_id = $1 and a.status = 'active' and a.kind = 'pipe' order by lower(a.name), a.id`, [farmId]);
  const counted = await tx.query<{ kind: string; count: string }>("select kind, count(*)::text as count from farm_map_assets where farm_id = $1 and status = 'active' and kind in ('trough', 'tank', 'bore', 'water_point') group by kind", [farmId]);
  const count = (kind: string) => Number(counted.rows.find((row) => row.kind === kind)?.count ?? 0);
  const pipes = rows.rows.map(toPipe);
  return {
    farmId,
    pipes,
    totalLengthM: pipes.reduce((total, pipe) => total + pipe.lengthM, 0),
    counts: { troughs: count("trough"), tanks: count("tank"), bores: count("bore"), waterPoints: count("water_point") },
  };
}

function figure(input: unknown, label: string, min: number, max: number, allowZero = false): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = typeof input === "number" ? input : typeof input === "string" && /^-?\d{1,6}(\.\d{1,3})?$/.test(input.trim()) ? Number(input.trim()) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max || (!allowZero && value === 0)) throw new ValidationError(`${label} is a number from ${min} to ${max.toLocaleString("en-NZ")}.`);
  return Math.round(value * 10) / 10;
}

/**
 * Says what a mapped pipe is (FW6): its inside diameter (mm), the flow
 * it's meant for (L/min) and its rise (m). Empty clears a figure. Farm
 * staff and up, as for the map's assets.
 */
export async function setPipeFigures(tx: OrgTx, assetIdInput: unknown, input: { insideMm?: unknown; flowLpm?: unknown; riseM?: unknown }): Promise<WaterPipe> {
  await requireFarming(tx);
  const assetId = requireId(assetIdInput, "assetId");
  const found = await tx.query<Row & { farm_id: string; kind: string }>(`select ${PIPE_COLUMNS}, a.farm_id::text, a.kind from farm_map_assets a where a.id = $1 and a.status = 'active'`, [assetId]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Map asset not found, or removed.");
  await requireFarmAccess(tx, row.farm_id, "Map asset not found, or removed.");
  if (row.kind !== "pipe") throw new ValidationError("Only a water pipe has a size and a flow.");
  const insideMm = figure(input.insideMm, "The inside diameter (mm)", MIN_INSIDE_MM, MAX_INSIDE_MM);
  const flowLpm = figure(input.flowLpm, "The flow (L/min)", 0.1, MAX_FLOW_LPM);
  const riseM = figure(input.riseM, "The rise (m)", -MAX_RISE_M, MAX_RISE_M, true);
  await tx.query("update farm_map_assets set pipe_inside_mm = $2, pipe_flow_lpm = $3, pipe_rise_m = $4, updated_by_email = $5, updated_at = now() where id = $1", [assetId, insideMm, flowLpm, riseM, tx.actor.email]);
  await writeAuditEvent(tx, {
    eventType: "farming.water_pipe_set",
    entityType: "farm_map_asset",
    entityId: assetId,
    details: { before: { insideMm: row.pipe_inside_mm, flowLpm: row.pipe_flow_lpm, riseM: row.pipe_rise_m }, after: { insideMm, flowLpm, riseM } },
  });
  return toPipe({ ...row, pipe_inside_mm: insideMm === null ? null : String(insideMm), pipe_flow_lpm: flowLpm === null ? null : String(flowLpm), pipe_rise_m: riseM === null ? null : String(riseM) });
}
