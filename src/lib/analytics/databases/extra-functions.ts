import { ValidationError } from "@/lib/errors";
import { MAX_EXTRA_FUNCTIONS } from "@/lib/analytics/databases/known-functions";

/** Functions that change something, read the server's files or reach another server. Refused when called. */
const FORBIDDEN_FUNCTIONS = new Set([
  "nextval",
  "setval",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_switch_wal",
  "pg_promote",
  "pg_notify",
  "pg_logical_emit_message",
  "load_file",
  "get_lock",
  "release_lock",
  "release_all_locks",
  "sys_exec",
  "sys_eval",
  // Run a query given as text, which this check can't read.
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "schema_to_xml",
  "schema_to_xml_and_xmlschema",
  "schema_to_xmlschema",
  "database_to_xml",
  "database_to_xml_and_xmlschema",
  "database_to_xmlschema",
  // Hold the connection without doing anything.
  "sleep",
  "benchmark",
]);

const FORBIDDEN_FUNCTION_PREFIXES = ["pg_advisory", "pg_try_advisory", "pg_ls_", "pg_create_", "pg_drop_", "pg_sleep", "pg_file_", "lo_", "dblink"];

export function forbiddenFunction(name: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(name) || FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The extra functions a connection allows in typed queries:
 * names only, a function Tohyee always refuses can't be listed.
 */
export function parseExtraFunctions(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const typed = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : null;
  if (!typed) throw new ValidationError("List the extra functions by name, with commas between them.");
  const names: string[] = [];
  for (const entry of typed) {
    if (typeof entry !== "string") throw new ValidationError("List the extra functions by name, with commas between them.");
    const name = entry.trim().replace(/\(\)$/, "").toLowerCase();
    if (!name) continue;
    if (!/^[a-z_][a-z0-9_$]{0,62}$/.test(name)) throw new ValidationError(`"${entry.trim()}" isn't a function name. Give the name only, without its schema or brackets.`);
    if (forbiddenFunction(name)) throw new ValidationError(`Tohyee only reads from the database, so ${name}() can't be allowed.`);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > MAX_EXTRA_FUNCTIONS) throw new ValidationError(`A connection can list up to ${MAX_EXTRA_FUNCTIONS} extra functions.`);
  return names.sort();
}
