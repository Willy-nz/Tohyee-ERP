import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { EMPLOYEE_IMPORT_FIELDS, importEmployees } from "@/lib/payroll/employee-import";

/** The fields a file's columns can be matched to (EMI2). */
export const GET = route(async () => json({ fields: EMPLOYEE_IMPORT_FIELDS.map((field) => ({ key: field.key, label: field.label })) }));

/** Previews (`commit` false) or brings in employees from a CSV or Excel file (EMI1-EMI8). */
export const POST = route(async (request) => {
  // A 5 MB file is about 6.7 MB as base64.
  const body = await readJson(request, { maxBytes: 8 * 1024 * 1024 });
  const result = await withPayrollAccess(request, body.organisationId, (tx) => importEmployees(tx, body, body.commit === true));
  return json(result);
});
