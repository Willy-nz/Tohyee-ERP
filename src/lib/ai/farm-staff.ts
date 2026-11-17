import type { AiAccessLevel } from "@/lib/ai/access-levels";
import type { Role } from "@/lib/auth/roles";

/*
 * Farm staff using an AI. The farm staff role reaches
 * nothing of the books: only field work, on the farms they're assigned
 *. Their AI gets exactly that and no more: the tools
 * below, each of which calls a service the field-work screens call, with
 * farm assignment enforced inside the service as it is for the screens.
 *
 * A tool is here only if its screen is one farm staff can open. Anything
 * with money in it (the farm Home's season cash and performance, benchmarks,
 * fertiliser plans and their costs, livestock values), the notebook, staff,
 * the AI's own tables and files, Analytics and get_organisation are left
 * out. Adding a farm tool elsewhere doesn't add it here: this list is the
 * decision.
 *
 * Browser-safe: the consent screen describes the choice from the same words.
 */

/** Who may have an AI key or connection at all: anyone who can read the books, and farm staff. */
export function roleMayUseAi(role: Role): boolean {
  return role === "farm_worker" || role === "viewer" || role === "bookkeeper" || role === "admin" || role === "owner";
}

export function isFarmStaff(role: Role): boolean {
  return role === "farm_worker";
}

/** Field records farm staff can read on their screens. */
export const FARM_STAFF_READ_TOOLS: readonly string[] = [
  "list_farms_and_paddocks",
  "pasture_cover",
  "list_pasture_readings",
  "list_grazings",
  "list_supplements_fed",
  "list_mobs",
  "list_animals",
  "get_animal",
  "mob_bcs",
  "list_animal_treatments",
  "farm_timeline",
  "rainfall",
  "list_rain_gauges",
  "list_farm_tasks",
  "farm_calendar",
  "farm_product_stock",
  "list_soil_tests",
  //: screens farm staff read on their own farms. Co-op shares and the year's figures are the business's, so not here.
  "farm_rotation_plan",
  "list_breeding_records",
  "list_tractor_equipment",
  "list_tractor_jobs",
  "effluent_log",
  "effluent_care",
  "farm_safety",
  //: more of the field screens. A paddock's history names fertiliser plans, which are the business's, so not here.
  "paddock_pasture",
  "paddock_statuses",
  "rain_gauge_summary",
  "list_soil_samples",
  "get_mob",
  "get_tractor_job",
  "farm_tasks_due",
  "farm_recent_weather",
  "farm_weather_forecast",
  "forecast_vs_gauge",
  "greenness_overview",
  //: the health and safety screens farm staff open; each service shows them only what their screen does. Cameras are not here.
  "safety_today",
  "safety_due",
  "list_safety_chemicals",
  "safety_equipment",
  "list_safety_equipment_checks",
  "safety_inductions",
  "list_safety_training",
  "safety_reports",
  "safety_record_history",
  //: more screens farm staff open. Benchmarks, the comparison and reporting set-up are the business's, so not here.
  "get_paddock",
  "farm_whats_due",
  "tractor_job_withholding",
  "farm_task_history",
  "effluent_today",
  "effluent_due",
  "list_bcs_scales",
  "list_stock_unit_factors",
  "list_pasture_photo_estimates",
  "pasture_photo_calibration",
  "list_farm_map_assets",
  "farm_team",
  "farm_people_locations",
  "effluent_setup",
  "list_mobs_named_on_grazings",
  "list_pasture_photos",
  "greenness_cover_check",
  "farm_terms",
  "farming_settings",
];

/** Field work farm staff can record on their screens. */
export const FARM_STAFF_RECORD_TOOLS: readonly string[] = [
  "record_pasture_reading",
  "record_grazing",
  "record_supplements_fed",
  "record_rainfall",
  "add_farm_task",
  "mark_farm_task_done",
  //: each is a screen farm staff already record on (Treatments, Body condition, an animal's quick entry, Soil samples).
  "record_animal_treatment",
  "record_bcs",
  "record_animal_weight",
  "record_soil_sample",
  //: the mob's Breeding tab and the effluent log's pond reading, which farm staff record on.
  "record_breeding",
  "record_pond_reading",
  //: effluent runs, which farm staff record on the Effluent log. Faults and incidents stay with a person.
  "record_effluent_application",
  "stop_effluent_application",
];

const READ = new Set(FARM_STAFF_READ_TOOLS);
const RECORD = new Set(FARM_STAFF_RECORD_TOOLS);

/** Whether a farm staff connection at this level may use the tool. */
export function farmStaffAllows(toolName: string, level: AiAccessLevel): boolean {
  return READ.has(toolName) || (level !== "read" && RECORD.has(toolName));
}

/** The levels farm staff can choose, in farm words. */
export const FARM_STAFF_LEVEL_LABELS: Record<"read" | "draft", string> = { read: "Look only", draft: "Record field work" };
export const FARM_STAFF_LEVEL_HELP: Record<"read" | "draft", string> = {
  read: "It can look up paddocks, covers, grazings, mobs, rain and tasks on your farms. It can't change anything.",
  draft: "It can also record cover readings, grazings, feed, rain, animal treatments, body condition, weights, soil samples and effluent runs, and add and tick off tasks, on your farms, as you. It can't see or touch the books, payroll or anything else.",
};

export function farmStaffRefusal(toolName: string): string {
  return `${toolName} isn't part of farm field work, which is all this connection is for. It can read and record field work on the farms you're assigned; the books and everything else are for the office.`;
}

export function farmStaffInstructions(organisationName: string, personName: string, level: AiAccessLevel): string {
  return (
    `Farm field work for ${organisationName} in Tohyee, as ${personName} (farm staff), on the farms they're assigned. ` +
    (level === "read"
      ? "You can look up paddocks, pasture covers, grazings, feed, mobs and animals, rain, tasks and the calendar. You can't change anything. "
      : "You can look up paddocks, pasture covers, grazings, feed, mobs and animals, rain, tasks and the calendar, and record cover readings, grazings, feed, rain, animal treatments, body condition scores, weights, soil samples and effluent runs, and add and tick off tasks. A treatment's withholding days are only ever what the person read from the label: never work them out or fill them in. ") +
    "You can't see or change the books, payroll, reports or settings: there are no tools for them here, so say so if asked. " +
    "Call list_farms_and_paddocks first for the farms and paddock ids. Covers are kg DM/ha; dates are YYYY-MM-DD. " +
    "Record what the person tells you, as they said it. If a paddock, mob or date isn't clear, ask before recording; otherwise don't ask again before each step."
  );
}
