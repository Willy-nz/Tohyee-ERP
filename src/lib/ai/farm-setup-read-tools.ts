import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema } from "@/lib/ai/tools";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { effluentDue, effluentToday } from "@/lib/effluent/care";
import { effluentSetup } from "@/lib/effluent/setup";
import { ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { listScales } from "@/lib/farming/bcs";
import { getYearFigures, listExpenseGroups } from "@/lib/farming/benchmarks";
import { farmComparison } from "@/lib/farming/comparison";
import { farmBenchmarksByFarm, getFarmReportingSetup } from "@/lib/farming/farm-reporting";
import { readFarmLocations } from "@/lib/farming/locations";
import { listMapAssets } from "@/lib/farming/map-assets";
import { linkableBillLines } from "@/lib/farming/fertiliser";
import { linkableMovements, listMobs, listStockUnitFactors, untypedMobs } from "@/lib/farming/mobs";
import { paddockStatuses } from "@/lib/farming/paddock-status";
import { getFarmingSettings, getPaddock, listFarms, requireFarming } from "@/lib/farming/paddocks";
import { listEstimates, listPasturePhotos, paddockPhotos, photoCalibration } from "@/lib/farming/pasture-photos";
import { coverCheck } from "@/lib/farming/vegetation/cover-model";
import { getRationsYear } from "@/lib/livestock/rations-adjustments";
import { farmTeam, taskHistory, tasksDue } from "@/lib/farming/tasks";
import { withheld } from "@/lib/farming/treatment-rules";
import { getFarmTerms } from "@/lib/farming/timeline";
import { getSprayWithholding } from "@/lib/farming/treatments";
import { safetyDue } from "@/lib/safety/today";
import { requireId } from "@/lib/validation";

/*
 * A fifth batch of farm reads: the reporting and
 * set-up screens, and the single records still without a tool. Each calls
 * the service its screen calls.
 */

const FARM_ID: JsonSchema = { type: "string", description: "The farm, from list_farms_and_paddocks. Leave out when there's only one." };
const PAGE = { limit: limitInput(100, 500), cursor: CURSOR };
const YEAR_END: JsonSchema = { ...DATE, description: "The financial year's last day (YYYY-MM-DD)." };

async function farmFor(tx: OrgTx, farmId: unknown): Promise<string> {
  if (farmId !== undefined && farmId !== null && farmId !== "") return String(farmId);
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  if (farms.length === 1) return farms[0].id;
  if (farms.length === 0) throw new ValidationError("There are no farms yet.");
  throw new ValidationError(`There are ${farms.length} farms: give farmId (list_farms_and_paddocks lists them).`);
}

function paged<T>(field: string, rows: readonly T[], args: Record<string, unknown>) {
  const page = pageByPosition(rows, args.cursor, boundedLimit(args.limit, 100, 500));
  return { [field]: page.rows, more: page.more, nextCursor: page.nextCursor };
}

/** Screens open to farm staff: field records and how the farm is set up. */
export const FARM_SETUP_READ_TOOLS: AiTool[] = [
  {
    name: "farm_whats_due",
    title: "What needs doing on a farm",
    description:
      "One answer to \"what's due on the farm?\": farm tasks due (overdue ones too), effluent dates (servicing, WoF, consent), health and safety items due, the mobs still within a meat or milk withholding period, and the paddocks not yet safe to graze after spraying. from defaults to today and to to seven days on. Each part comes from its own screen's service; the single tools (farm_tasks_due, effluent_due, safety_due, list_mobs, paddock_statuses) give more.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, from: DATE, to: DATE }),
    run: async (tx, args) => {
      const farmId = await farmFor(tx, args.farmId);
      const today = todayIsoDate();
      const from = args.from ? parseIsoDate(args.from, "From") : today;
      const to = args.to ? parseIsoDate(args.to, "To") : new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      if (to < from) throw new ValidationError("The end date is before the start date.");
      const range = { from, to, farmId };
      const mobs = (await listMobs(tx, { farmId })).filter((mob) => {
        const now = withheld(mob.withholding, today);
        return now.meat || now.milk;
      });
      const paddocks = (await paddockStatuses(tx, { farmId, onDate: today })).filter((paddock) => paddock.notSafeUntil);
      return {
        from,
        to,
        tasks: await tasksDue(tx, range),
        effluent: await effluentDue(tx, range),
        safety: await safetyDue(tx, range),
        mobsWithheld: mobs.map((mob) => ({ mobId: mob.id, name: mob.name, head: mob.head, meatSafeOn: mob.withholding?.meatSafeOn ?? null, milkSafeFrom: mob.withholding?.milkSafeFrom ?? null })),
        paddocksNotSafeToGraze: paddocks.map((paddock) => ({ paddockId: paddock.paddockId, name: paddock.name, until: paddock.notSafeUntil!.until, product: paddock.notSafeUntil!.product })),
      };
    },
  },
  {
    name: "get_paddock",
    title: "One paddock",
    description: "One paddock in full: its details and every version of its boundary. Paddocks come from list_farms_and_paddocks.",
    level: "read",
    inputSchema: schema({ paddockId: { type: "string", description: "The paddock's id, from list_farms_and_paddocks." } }, ["paddockId"]),
    run: async (tx, args) => ({ paddock: await getPaddock(tx, args.paddockId) }),
  },
  {
    name: "tractor_job_withholding",
    title: "A spray job's withholding",
    description: "The grazing withholding set for a spray job from its label: the days, and the first day its paddocks are safe to graze. Null when none is set: don't work one out yourself.",
    level: "read",
    inputSchema: schema({ jobId: { type: "string", description: "The job, from list_tractor_jobs." } }, ["jobId"]),
    run: async (tx, args) => ({ withholding: await getSprayWithholding(tx, args.jobId) }),
  },
  {
    name: "farm_task_history",
    title: "A farm task's history",
    description: "Everything done for one farm task, newest first: when, who by, and any that were undone. Tasks come from list_farm_tasks.",
    level: "read",
    inputSchema: schema({ taskId: { type: "string", description: "The task, from list_farm_tasks." }, ...PAGE }, ["taskId"]),
    run: async (tx, args) => paged("history", await taskHistory(tx, args.taskId), args),
  },
  {
    name: "effluent_today",
    title: "Effluent today",
    description: "What Today shows from Effluent for a farm: the reminders and open incidents. Empty for a farm with no effluent systems.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => effluentToday(tx, await farmFor(tx, args.farmId)),
  },
  {
    name: "effluent_due",
    title: "Effluent dates",
    description: "Effluent's dates between two days, as the farm calendar shows them: servicing, the Effluent WoF and the consent's expiry.",
    level: "read",
    inputSchema: schema({ from: DATE, to: DATE, farmId: { type: "string", description: "One farm only." }, ...PAGE }, ["from", "to"]),
    run: async (tx, args) =>
      paged("items", await effluentDue(tx, { from: parseIsoDate(args.from, "From"), to: parseIsoDate(args.to, "To"), farmId: typeof args.farmId === "string" && args.farmId ? args.farmId : null }), args),
  },
  {
    name: "list_bcs_scales",
    title: "Body condition scales",
    description: "Each kind of stock's body condition scale on a farm: the scale, its targets and descriptions, and which scores have reference photos.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => paged("scales", await listScales(tx, { farmId: await farmFor(tx, args.farmId) }), args),
  },
  {
    name: "list_stock_unit_factors",
    title: "Stock unit factors",
    description: "The stock units counted for one head of each class, used for stocking rates.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => paged("factors", await listStockUnitFactors(tx), args),
  },
  {
    name: "list_pasture_photo_estimates",
    title: "Pasture photo estimates",
    description: "A farm's pasture cover estimates from photos: those waiting for a person to decide, and the latest decided. A person accepts, changes or declines each one.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => {
      const found = await listEstimates(tx, { farmId: await farmFor(tx, args.farmId) });
      return { waiting: found.waiting, ...paged("decided", found.decided, args) };
    },
  },
  {
    name: "pasture_photo_calibration",
    title: "How close photo estimates have been",
    description: "How far a farm's photo estimates were from other readings of the same paddock within a few days, over the year to today, by method.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, windowDays: { type: "integer", minimum: 1, description: "How many days apart two readings can be to compare (default as the screen)." } }),
    run: async (tx, args) => photoCalibration(tx, { farmId: await farmFor(tx, args.farmId), windowDays: args.windowDays ?? undefined }),
  },
  {
    name: "list_farm_map_assets",
    title: "Things on the farm map",
    description: "What's drawn on a farm's map besides paddocks: points (troughs, gates, water points, sheds, bores, tanks, yards, culverts) and lines (fences, water pipes, races, drains), each with its name, note and where it is.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => paged("assets", await listMapAssets(tx, await farmFor(tx, args.farmId)), args),
  },
  {
    name: "farm_team",
    title: "A farm's team",
    description: "Who can record farm work on a farm now: each person's name and role. For assigning a task.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => {
      await requireFarming(tx);
      const farmId = requireId(await farmFor(tx, args.farmId), "farmId");
      await requireFarmAccess(tx, farmId);
      return { people: await farmTeam(tx, farmId) };
    },
  },
  {
    name: "farm_people_locations",
    title: "Who's sharing where they are",
    description:
      "The people sharing where they are with a farm right now, as the farm map shows them to that farm's members: each one's name, when their sharing started and ends, and their latest position with its accuracy and time. Only people who chose to share, only while their sharing lasts, and only the latest position (no trail is kept). Someone not listed isn't sharing: that says nothing about where they are.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => readFarmLocations(tx, await farmFor(tx, args.farmId)),
  },
  {
    name: "effluent_setup",
    title: "Effluent set-up",
    description: "How a farm's effluent is set up, as Effluent › Set-up shows it: systems (and whether each is in use), ponds, blocks, buffer zones and consents.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, includeWithdrawn: { type: "boolean" } }),
    run: async (tx, args) => effluentSetup(tx, await farmFor(tx, args.farmId), { includeWithdrawn: args.includeWithdrawn === true }),
  },
  {
    name: "list_mobs_named_on_grazings",
    title: "Mobs named only on grazings",
    description: "Mob names typed on grazings that have no mob record yet, with the paddocks each is in now, its head and how many grazings name it. A person makes the mob records.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => paged("mobs", await untypedMobs(tx, { farmId: await farmFor(tx, args.farmId) }), args),
  },
  {
    name: "list_pasture_photos",
    title: "Pasture photos",
    description: "A farm's pasture photos, newest first, or one paddock's photo diary: when and where each was taken, who sent it, its note, and the reading or estimate it goes with. The details only, not the pictures; get_pasture_photo shows one waiting for an estimate.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, paddockId: { type: "string", description: "One paddock's diary." }, limit: limitInput(100, 200), cursor: CURSOR }),
    run: async (tx, args) => {
      const photos = args.paddockId ? await paddockPhotos(tx, args.paddockId, 200) : await listPasturePhotos(tx, { farmId: await farmFor(tx, args.farmId), limit: 200 });
      const page = pageByPosition(photos, args.cursor, boundedLimit(args.limit, 100, 200));
      return { photos: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
  },
  {
    name: "greenness_cover_check",
    title: "Cover from greenness: how good is the line",
    description: "For a farm's pasture cover worked out from satellite greenness: the line fitted now, how it did on dates and farms it wasn't fitted on, and the line in use. Worked out only; turning a line on or off is for a person.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => ({ check: await coverCheck(tx, await farmFor(tx, args.farmId)) }),
  },
  {
    name: "farm_terms",
    title: "Farm words",
    description: "The words this organisation has chosen for its farm screens in place of Tohyee's own, by the word's key. Empty when it uses Tohyee's words. Display only.",
    level: "read",
    inputSchema: schema({}),
    run: async (tx) => ({ terms: await getFarmTerms(tx) }),
  },
  {
    name: "farming_settings",
    title: "Farming settings",
    description: "Whether Farming is on, and whether an aerial imagery key is saved and when (the key itself isn't given).",
    level: "read",
    inputSchema: schema({}),
    run: async (tx) => {
      const settings = await getFarmingSettings(tx);
      return { enabled: settings.enabled, hasImageryKey: settings.imageryKey !== null, imageryKeySavedOn: settings.imageryKeySavedOn };
    },
  },
];

/** Screens for people who can read the books: money and whole-business figures. Not for farm staff. */
export const FARM_REPORTING_READ_TOOLS: AiTool[] = [
  {
    name: "farm_benchmarks_by_farm",
    title: "Benchmarks by farm",
    description: "A year's farm benchmarks split by farm: one column per farm, what isn't allocated to a farm, and the total (the same total farm_benchmarks gives).",
    level: "read",
    inputSchema: schema({ yearEnd: YEAR_END }, ["yearEnd"]),
    run: (tx, args) => farmBenchmarksByFarm(tx, { yearEnd: args.yearEnd }),
  },
  {
    name: "farm_comparison",
    title: "Compare farms",
    description: "Each active farm side by side on a date (default today): paddocks and hectares, latest pasture readings and the latest fertiliser plan, with the figures for all farms together.",
    level: "read",
    inputSchema: schema({ onDate: DATE }),
    run: (tx, args) => farmComparison(tx, { onDate: args.onDate ?? todayIsoDate() }),
  },
  {
    name: "farm_reporting_setup",
    title: "Farm reporting set-up",
    description: "How farms are tied to the books for reporting by farm: the tracking category that says which farm a line is for, its values, and which value each farm is linked to.",
    level: "read",
    inputSchema: schema({}),
    run: (tx) => getFarmReportingSetup(tx),
  },
  {
    name: "list_farm_expense_groups",
    title: "Farm working expense groups",
    description: "Every active expense account and the farm working-expense group it's in, if any, as the benchmarks use them.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => paged("accounts", await listExpenseGroups(tx), args),
  },
  {
    name: "list_fertiliser_bill_lines",
    title: "Fertiliser bill lines",
    description: "Approved bill lines on the fertiliser or spreading account, newest first, and whether each is linked to a fertiliser plan yet. A person does the linking.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => paged("lines", await linkableBillLines(tx), args),
  },
  {
    name: "list_mob_linkable_movements",
    title: "Livestock movements a mob's sale or purchase could link to",
    description: "Livestock movements from the last 120 days that a mob's sale or purchase could be linked to: the same type, kind and class, not voided and not linked to a mob yet. Empty when Livestock is off. For bookkeepers and up, as on the screen.",
    level: "read",
    minRole: "bookkeeper",
    inputSchema: schema({ mobId: { type: "string", description: "The mob, from list_mobs." }, type: { type: "string", enum: ["sale", "purchase"] }, ...PAGE }, ["mobId", "type"]),
    run: async (tx, args) => paged("movements", await linkableMovements(tx, args.mobId, { type: args.type }), args),
  },
  {
    name: "livestock_rations_year",
    title: "A year's rations adjustment",
    description: "A year's homekill for the owner and staff: the head count, what was posted for each event before, and the year's adjustment. For bookkeepers and up, as on the screen. Worked out only: posting the adjustment is for a person.",
    level: "read",
    minRole: "bookkeeper",
    inputSchema: schema({ yearEnd: YEAR_END }, ["yearEnd"]),
    run: (tx, args) => getRationsYear(tx, { yearEnd: args.yearEnd }),
  },
  {
    name: "farm_benchmark_year_figures",
    title: "A year's benchmark figures",
    description: "The whole-business figures entered for a year's benchmarks: effective hectares, peak cows, stock units and milk solids, with the paddocks' effective area today for when the year's isn't entered. farm_year_figures gives them by farm.",
    level: "read",
    inputSchema: schema({ yearEnd: YEAR_END }, ["yearEnd"]),
    run: (tx, args) => getYearFigures(tx, args.yearEnd),
  },
];
