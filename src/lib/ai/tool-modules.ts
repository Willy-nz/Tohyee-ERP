import type { OrgTx } from "@/lib/db/org-transaction";

/**
 * Which AI tools an organisation's modules offer.
 *
 * The MCP tool list follows the same module switches as the app's menus
 * (src/components/navigation.ts, src/components/modules.tsx): an
 * organisation that doesn't farm isn't offered farm tools, one without
 * livestock isn't offered livestock tools, and so on. The tool list's
 * version is a hash of the tools offered, so switching a
 * module on or off changes the version and the client is told
 * (notifications/tools/list_changed). Calls to a hidden tool are refused
 * with the reason. This narrows what's offered; it never grants anything
 * (access level and role still decide).
 */

/** The module switches the tool list follows, as the menus see them (Settings › Modules). */
export type ToolModules = {
  /** Accounting (MOD2): false only when it's been turned off. */
  accounting: boolean;
  /** Farming: needs Accounting. */
  farming: boolean;
  /** Livestock: part of Accounting. */
  livestock: boolean;
  /** Advanced reporting: tracking categories and custom fields. */
  reporting: boolean;
  /** Not-for-profit: fund tracking. */
  notForProfit: boolean;
  /** Analytics: its own module, apart from Accounting. */
  analytics: boolean;
  /** Chat (TCH1): the team chat, its own module. Left out means off. */
  chat?: boolean;
};

export type ToolGroupKey = "accounting" | "farming" | "livestock" | "tracking" | "analytics" | "chat";

type ToolGroup = {
  key: ToolGroupKey;
  label: string;
  /** Tool names in this group (accounting is every catalogue tool not in another group or ALWAYS_OFFERED). */
  tools: readonly string[];
  /** Null when the group is on; otherwise why it's hidden, in words for the AI. */
  hiddenBecause(modules: ToolModules): string | null;
};

/** Offered whatever modules are on: the organisation itself, and the AI's own workspace (files, tables, dashboards). */
export const ALWAYS_OFFERED: readonly string[] = [
  "get_organisation",
  "get_organisation_directory",
  "list_ai_uploads",
  "read_ai_upload",
  "list_datasets",
  "query_dataset",
  "list_ai_dashboards",
  "get_ai_dashboard",
  "save_dataset",
  "add_dataset_rows",
];

const ACCOUNTING_OFF = "Accounting is turned off for this organisation (Settings › Modules).";

/** Farms, paddocks, pasture, soil, fertiliser and the farm notebook: the Farm app's menus (FARM_MENUS, module "farming"). */
export const FARMING_TOOLS: readonly string[] = [
  "farm_notebook",
  "add_farm_note",
  "update_farm_note",
  "list_farms_and_paddocks",
  "farm_benchmarks",
  "list_soil_tests",
  "list_fertiliser_products",
  "list_fertiliser_plans",
  "get_fertiliser_plan",
  "fertiliser_what_if",
  "pasture_cover",
  "list_pasture_readings",
  "list_grazings",
  "list_mobs",
  "list_animal_treatments",
  "farm_timeline",
  "list_animals",
  "get_animal",
  "mob_bcs",
  "list_supplements_fed",
  "rainfall",
  "weather_forecast_records",
  "paddock_greenness",
  "list_pasture_photos_awaiting_estimate",
  "get_pasture_photo",
  "propose_pasture_cover_estimate",
  "list_bcs_photos_to_score",
  "get_bcs_photos_to_score",
  "suggest_bcs",
  // Field work recorded through the AI.
  "list_farm_tasks",
  "read_farm_chat",
  "list_rain_gauges",
  "farm_home",
  "farm_calendar",
  "farm_product_stock",
  // More of what the farm screens show.
  "farm_rotation_plan",
  "list_breeding_records",
  "list_tractor_equipment",
  "list_tractor_jobs",
  "effluent_log",
  "effluent_care",
  "farm_safety",
  "coop_share_schedule",
  "farm_year_figures",
  // Single records, weather and status.
  "paddock_pasture",
  "paddock_history",
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
  // Health and safety and the camera log.
  "safety_today",
  "safety_due",
  "list_safety_chemicals",
  "safety_equipment",
  "list_safety_equipment_checks",
  "safety_inductions",
  "list_safety_training",
  "safety_reports",
  "safety_record_history",
  "check_safety_history",
  "list_security_cameras",
  "list_security_camera_events",
  "get_security_camera_event",
  // Reporting, set-up and single records.
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
  "list_fertiliser_bill_lines",
  "list_mob_linkable_movements",
  "farm_terms",
  "farming_settings",
  "farm_benchmarks_by_farm",
  "farm_comparison",
  "farm_reporting_setup",
  "list_farm_expense_groups",
  "farm_benchmark_year_figures",
  "record_breeding",
  "record_pond_reading",
  "record_effluent_application",
  "stop_effluent_application",
  // Make and post on the farm.
  "move_mob",
  "count_mob",
  "record_mob_births",
  "record_mob_deaths",
  //.
  "sell_from_mob",
  "buy_into_mob",
  "change_mob_class",
  "split_mob",
  "merge_mobs",
  "undo_mob_event",
  "record_pasture_reading",
  "record_grazing",
  "record_supplements_fed",
  "record_rainfall",
  "add_farm_task",
  "mark_farm_task_done",
  "post_farm_chat_message",
  "record_animal_treatment",
  "record_bcs",
  "record_animal_weight",
  "record_soil_sample",
];

/** Livestock: the Accounting › Livestock links (module "livestock"). */
export const LIVESTOCK_TOOLS: readonly string[] = [
  "livestock_overview",
  "list_livestock_movements",
  "list_livestock_elections",
  // The Livestock year-end screens.
  "livestock_settings",
  "list_livestock_openings",
  "list_livestock_locations",
  "list_livestock_rates",
  "list_high_priced_livestock",
  "list_livestock_account_sales",
  "list_livestock_management_values",
  "livestock_management_report",
  "livestock_ageing_preview",
  "livestock_valuation_preview",
  "list_livestock_suggestions",
  "suggest_livestock_movements",
  "record_livestock_movement",
  "livestock_rations_year",
  "void_livestock_movement",
];

/** Tracking categories: Settings › Tracking categories shows with Advanced reporting, which the tracking service itself needs (Not-for-profit's fund tracking does too). */
export const TRACKING_TOOLS: readonly string[] = [
  "list_tracking",
  "create_tracking_category",
  "update_tracking_category",
  "create_tracking_option",
  "update_tracking_option",
];

/** Analytics reports and their tables: the Analytics app (Settings › Modules › Analytics), apart from Accounting. */
export const ANALYTICS_TOOLS: readonly string[] = [
  "list_analytics_tables",
  "analytics_format_guide",
  "run_analytics_query",
  "list_analytics_dashboards",
  "get_analytics_dashboard",
  "create_analytics_dashboard",
  "create_analytics_dashboard_from_template",
  "update_analytics_dashboard",
  "suggest_analytics_commentary",
  "refresh_analytics_sources",
  "add_analytics_image",
  "change_analytics_picture",
  "delete_analytics_dashboard",
];

const GROUPS: readonly ToolGroup[] = [
  {
    key: "farming",
    label: "Farming (farms, paddocks, pasture, soil, fertiliser, farm notebook)",
    tools: FARMING_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting ? ACCOUNTING_OFF : modules.farming ? null : "Farming is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "livestock",
    label: "Livestock (stock on hand, movements)",
    tools: LIVESTOCK_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting ? ACCOUNTING_OFF : modules.livestock ? null : "Livestock is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "tracking",
    label: "Tracking categories",
    tools: TRACKING_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting
        ? ACCOUNTING_OFF
        : modules.reporting
          ? null
          : "Tracking categories come with Advanced reporting, which is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "analytics",
    label: "Analytics (reports over the books, Shopify, Google, Meta, files and databases)",
    tools: ANALYTICS_TOOLS,
    hiddenBecause: (modules) => (modules.analytics ? null : "Analytics is turned off for this organisation (Settings › Modules)."),
  },
  {
    key: "chat",
    label: "Chat (the team chat)",
    tools: ["read_team_chat", "post_team_chat_message"],
    hiddenBecause: (modules) => (modules.chat ? null : "Chat is turned off for this organisation (Settings › Modules)."),
  },
];

const ACCOUNTING_GROUP: ToolGroup = {
  key: "accounting",
  label: "Accounting (invoices, bills, banking, reports, GST, and the rest of the books)",
  tools: [],
  hiddenBecause: (modules) => (modules.accounting ? null : ACCOUNTING_OFF),
};

/** The group a tool belongs to, or null for one that's always offered (and tools that aren't in the catalogue, like private mail). */
export function toolGroupOf(name: string): ToolGroup | null {
  if (ALWAYS_OFFERED.includes(name)) return null;
  return GROUPS.find((group) => group.tools.includes(name)) ?? ACCOUNTING_GROUP;
}

/** Why the organisation's modules hide this tool, or null when they don't. */
export function moduleHidesTool(name: string, modules: ToolModules | null): string | null {
  if (!modules) return null;
  const group = toolGroupOf(name);
  const reason = group?.hiddenBecause(modules) ?? null;
  return reason ? `${name} isn't offered: ${reason}` : null;
}

/** For get_organisation: each tool group, whether it's offered, and why not. */
export type ToolGroupStatus = { group: ToolGroupKey; label: string; offered: boolean; hiddenBecause?: string };

export function toolGroupStatuses(modules: ToolModules | null): ToolGroupStatus[] {
  return [ACCOUNTING_GROUP, ...GROUPS].map((group) => {
    const reason = modules ? group.hiddenBecause(modules) : null;
    return reason ? { group: group.key, label: group.label, offered: false, hiddenBecause: reason } : { group: group.key, label: group.label, offered: true };
  });
}

type ModuleRow = {
  accounting_enabled: boolean;
  farming_enabled: boolean;
  livestock_enabled: boolean;
  advanced_features: boolean;
  not_for_profit_enabled: boolean;
  analytics_enabled: boolean;
  chat_enabled?: boolean;
};

/** The switches from organisation_settings, as useModules (the menus) reads them: Farming and Livestock need Accounting. */
export function toolModulesFrom(row: ModuleRow): ToolModules {
  const accounting = row.accounting_enabled !== false;
  return {
    accounting,
    farming: accounting && row.farming_enabled === true,
    livestock: accounting && row.livestock_enabled === true,
    reporting: row.advanced_features === true,
    notForProfit: row.not_for_profit_enabled === true,
    analytics: row.analytics_enabled === true,
    chat: row.chat_enabled === true,
  };
}

export async function loadToolModules(tx: OrgTx): Promise<ToolModules> {
  const result = await tx.query<ModuleRow>(
    `select accounting_enabled, advanced_features, not_for_profit_enabled, analytics_enabled,
            coalesce((select enabled from livestock_settings where id = true), false) as livestock_enabled,
            coalesce((select enabled from farming_settings where id = true), false) as farming_enabled,
            coalesce((select enabled from team_chat_settings where id = true), false) as chat_enabled
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  return row
    ? toolModulesFrom(row)
    : { accounting: true, farming: false, livestock: false, reporting: false, notForProfit: false, analytics: false };
}
