import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema } from "@/lib/ai/tools";
import { businessTimeZone, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { listFarms } from "@/lib/farming/paddocks";
import { equipmentChecks, listEquipment } from "@/lib/safety/equipment";
import { listInductions, listSignoffs, onSite } from "@/lib/safety/inductions";
import { checkSafetyHistory, recordHistory } from "@/lib/safety/records";
import { listChemicals, listTraining } from "@/lib/safety/register";
import { farmActionsWithoutReport, listReports } from "@/lib/safety/reports";
import { safetyDue, safetyToday } from "@/lib/safety/today";
import { listCameras } from "@/lib/security-cameras/cameras";
import { getEvent, listEvents } from "@/lib/security-cameras/events";

/*
 * Reads for health and safety and the security cameras. The owner's choices: the AI may read everything in health and safety
 * that the person can already see, and the camera list and events log but
 * never a picture or video.
 *
 * Each tool calls the service its screen calls, so the person's farms, the
 * restricted details of a report (only for those given that access) and who
 * may look at cameras are decided there, as on the screens. Left with a
 * person: site sign-in links, sending inductions to sign, who has restricted
 * access, camera set-up and logins, and every file, picture and clip.
 */

const FARM_ID: JsonSchema = { type: "string", description: "The farm, from list_farms_and_paddocks. Leave out when there's only one." };
const PAGE = { limit: limitInput(100, 500), cursor: CURSOR };

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

export const SAFETY_READ_TOOLS: AiTool[] = [
  {
    name: "safety_today",
    title: "Health and safety today",
    description: "A farm's health and safety for today as the person's Today screen shows it: their own actions, and for those who manage safety, what's overdue and what's waiting to be checked, with active hazards and equipment.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => safetyToday(tx, await farmFor(tx, args.farmId)),
  },
  {
    name: "safety_due",
    title: "Health and safety due",
    description: "Health and safety items falling due between two dates (checks, reviews, training and the like), for one farm or all the person's farms.",
    level: "read",
    inputSchema: schema({ from: DATE, to: DATE, farmId: { type: "string", description: "One farm only." }, ...PAGE }, ["from", "to"]),
    run: async (tx, args) =>
      paged("items", await safetyDue(tx, { from: parseIsoDate(args.from, "From"), to: parseIsoDate(args.to, "To"), farmId: typeof args.farmId === "string" && args.farmId ? args.farmId : null }), args),
  },
  {
    name: "list_safety_chemicals",
    title: "Chemical register",
    description: "A farm's hazardous substances register as Health and safety › Chemicals shows it.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => paged("chemicals", await listChemicals(tx, await farmFor(tx, args.farmId)), args),
  },
  {
    name: "safety_equipment",
    title: "Equipment register",
    description: "A farm's equipment for health and safety, with each one's state, and the pre-start checklists in use.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => listEquipment(tx, await farmFor(tx, args.farmId)),
  },
  {
    name: "list_safety_equipment_checks",
    title: "An equipment's checks",
    description: "The pre-start checks recorded for one piece of equipment, newest first. Equipment comes from safety_equipment (its recordId).",
    level: "read",
    inputSchema: schema({ equipmentId: { type: "string", description: "The equipment's recordId, from safety_equipment." }, ...PAGE }, ["equipmentId"]),
    run: async (tx, args) => paged("checks", await equipmentChecks(tx, args.equipmentId), args),
  },
  {
    name: "safety_inductions",
    title: "Inductions and who's on site",
    description: "A farm's inductions, who has signed each off, and who is signed in on site now. These name people. The links people use to sign in on site aren't included.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID }),
    run: async (tx, args) => {
      const farmId = await farmFor(tx, args.farmId);
      return { inductions: await listInductions(tx, farmId), signoffs: await listSignoffs(tx, farmId), onSite: await onSite(tx, farmId) };
    },
  },
  {
    name: "list_safety_training",
    title: "Training register",
    description: "The training and competency register: who holds what, and when each expires. mine gives only the person's own. These name people.",
    level: "read",
    inputSchema: schema({ mine: { type: "boolean", description: "Only the person's own training." }, ...PAGE }),
    run: async (tx, args) => paged("training", await listTraining(tx, { mine: args.mine === true }), args),
  },
  {
    name: "safety_reports",
    title: "Incident and near-miss reports",
    description:
      "A farm's health and safety reports (incidents, near misses, hazards raised) with their state, actions and whether each may be notifiable, plus actions not tied to a report. These name people. A report's restricted details show only to those given that access (detailsHidden says when there are some the person can't see). Attached files are named, not read.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, includeWithdrawn: { type: "boolean" } }),
    run: async (tx, args) => {
      const farmId = await farmFor(tx, args.farmId);
      return { reports: await listReports(tx, farmId, { includeWithdrawn: args.includeWithdrawn === true }), otherActions: await farmActionsWithoutReport(tx, farmId) };
    },
  },
  {
    name: "safety_record_history",
    title: "A safety record's history",
    description: "Every version of one health and safety record (a hazard, report, action, chemical, equipment, training or induction), oldest first: what changed, who changed it and when.",
    level: "read",
    inputSchema: schema({ recordId: { type: "string", description: "The record's recordId, from the list it's in." } }, ["recordId"]),
    run: async (tx, args) => ({ versions: await recordHistory(tx, args.recordId) }),
  },
  {
    name: "check_safety_history",
    title: "Check the safety history",
    description: "Checks that the health and safety history hasn't been altered: each entry is chained to the one before, and this walks the chain and says whether it holds.",
    level: "read",
    inputSchema: schema({}),
    run: (tx) => checkSafetyHistory(tx, null),
  },
];

export const CAMERA_READ_TOOLS: AiTool[] = [
  {
    name: "list_security_cameras",
    title: "Security cameras",
    description: "The security cameras the person may see: farm, name, model, notes, where it is, whether it's active, when it last sent something and how many events it has. No pictures, video or logins.",
    level: "read",
    inputSchema: schema({ farmId: { type: "string", description: "One farm only." }, ...PAGE }),
    run: async (tx, args) =>
      paged(
        "cameras",
        (await listCameras(tx, { farmId: args.farmId })).map((camera) => ({ ...camera, uploadUsername: undefined, uploadLoginMadeAt: undefined })),
        args,
      ),
  },
  {
    name: "list_security_camera_events",
    title: "Security camera events",
    description:
      "The security cameras' events log, newest first: which camera, when, whether it's a snapshot or a clip, what was detected, and whether it's been kept. Filter by farm, camera, kind, dates or kept. This is the log only: the pictures and video are never given.",
    level: "read",
    inputSchema: schema({
      farmId: { type: "string" },
      cameraId: { type: "string", description: "One camera, from list_security_cameras." },
      kind: { type: "string", enum: ["snapshot", "clip"] },
      from: DATE,
      to: DATE,
      kept: { type: "boolean", description: "Only events that have been kept." },
      limit: limitInput(60, 60),
      cursor: CURSOR,
    }),
    run: async (tx, args) => {
      const found = await listEvents(
        tx,
        {
          farmId: args.farmId ?? null,
          cameraId: args.cameraId ?? null,
          kind: args.kind ?? null,
          from: args.from ?? null,
          to: args.to ?? null,
          kept: args.kept === true,
          // The cursor is the last event of the page before.
          before: typeof args.cursor === "string" && args.cursor ? args.cursor : null,
          limit: boundedLimit(args.limit, 60, 60),
        },
        businessTimeZone(),
      );
      return { events: found.events, more: found.more, nextCursor: found.more ? (found.events.at(-1)?.id ?? null) : null };
    },
  },
  {
    name: "get_security_camera_event",
    title: "One security camera event",
    description: "One event from the security cameras' log: the camera, the times (the camera's and when it arrived), what was detected and whether it's kept. Never the picture or video.",
    level: "read",
    inputSchema: schema({ eventId: { type: "string", description: "The event, from list_security_camera_events." } }, ["eventId"]),
    run: async (tx, args) => ({ event: await getEvent(tx, args.eventId) }),
  },
];
