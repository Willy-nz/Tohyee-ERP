import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

/*
 * The organisation's directory (15 Nov 2026: "Add them to org settings"): the details a report's directory page
 * prints, kept once with the organisation instead of typed on every report.
 * Words only: nothing here changes how anything is posted or reported.
 */

export type DirectoryLine = { label: string; value: string };
export type OrganisationDirectory = {
  /** Where the organisation is registered, if that isn't its postal address. */
  registeredOffice: string | null;
  /** NZBN, company number, charity registration number… */
  numbers: DirectoryLine[];
  /** Directors, trustees, committee members: `label` is the role, `value` the name. */
  officers: DirectoryLine[];
  /** Accountant, bank, solicitor, auditor: `label` is what they are, `value` who. */
  advisers: DirectoryLine[];
};

export const DIRECTORY_LIMITS = { registeredOffice: 500, numbers: 6, officers: 30, advisers: 10, label: 60, value: 200 };
export const EMPTY_DIRECTORY: OrganisationDirectory = { registeredOffice: null, numbers: [], officers: [], advisers: [] };

function lines(input: unknown, what: string, max: number): DirectoryLine[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ValidationError(`${what} is a list.`);
  if (input.length > max) throw new ValidationError(`${what}: up to ${max}.`);
  return input.flatMap((entry) => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const value = typeof raw.value === "string" ? raw.value.trim() : "";
    // A row left blank on the form is just dropped.
    if (!label && !value) return [];
    if (!value) throw new ValidationError(`${what}: "${label}" needs a name or number beside it.`);
    if (label.length > DIRECTORY_LIMITS.label) throw new ValidationError(`${what}: a label can be up to ${DIRECTORY_LIMITS.label} characters.`);
    if (value.length > DIRECTORY_LIMITS.value) throw new ValidationError(`${what}: an entry can be up to ${DIRECTORY_LIMITS.value} characters.`);
    return [{ label, value }];
  });
}

export function parseDirectory(input: unknown): OrganisationDirectory {
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const office = typeof raw.registeredOffice === "string" ? raw.registeredOffice.trim() : "";
  if (raw.registeredOffice !== undefined && raw.registeredOffice !== null && typeof raw.registeredOffice !== "string") throw new ValidationError("The registered office is text.");
  if (office.length > DIRECTORY_LIMITS.registeredOffice) throw new ValidationError(`The registered office can be up to ${DIRECTORY_LIMITS.registeredOffice} characters.`);
  return {
    registeredOffice: office || null,
    numbers: lines(raw.numbers, "Registration numbers", DIRECTORY_LIMITS.numbers),
    officers: lines(raw.officers, "Directors, trustees or officers", DIRECTORY_LIMITS.officers),
    advisers: lines(raw.advisers, "Advisers", DIRECTORY_LIMITS.advisers),
  };
}

export async function getOrganisationDirectory(tx: OrgTx): Promise<OrganisationDirectory> {
  const result = await tx.query<{ directory: unknown }>("select directory from organisation_settings where id = true");
  const stored = result.rows[0]?.directory;
  // What's stored was checked when it was saved; anything unreadable shows as empty rather than breaking a report.
  try {
    return stored ? parseDirectory(stored) : EMPTY_DIRECTORY;
  } catch {
    return EMPTY_DIRECTORY;
  }
}

export async function saveOrganisationDirectory(tx: OrgTx, input: unknown): Promise<OrganisationDirectory> {
  const directory = parseDirectory(input);
  const empty = !directory.registeredOffice && directory.numbers.length + directory.officers.length + directory.advisers.length === 0;
  await tx.query("update organisation_settings set directory = $1::jsonb, updated_at = now() where id = true", [empty ? null : JSON.stringify(directory)]);
  await writeAuditEvent(tx, {
    eventType: "organisation.directory_updated",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { registeredOffice: Boolean(directory.registeredOffice), numbers: directory.numbers.length, officers: directory.officers.length, advisers: directory.advisers.length },
  });
  return directory;
}

/** A directory page's lines: what Tohyee holds about the organisation, in the order a directory reads. */
export type DirectoryPage = { name: string; sections: Array<{ title: string; lines: DirectoryLine[] }> };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function directoryPage(
  organisation: { displayName: string; postalAddress: string | null; gstNumber: string | null; financialYearEndMonth: number },
  directory: OrganisationDirectory,
): DirectoryPage {
  const lastDay = new Date(Date.UTC(2001, organisation.financialYearEndMonth, 0)).getUTCDate();
  const details: DirectoryLine[] = [
    ...(directory.registeredOffice ? [{ label: "Registered office", value: directory.registeredOffice }] : []),
    ...(organisation.postalAddress ? [{ label: "Postal address", value: organisation.postalAddress }] : []),
    ...directory.numbers,
    ...(organisation.gstNumber ? [{ label: "GST number", value: organisation.gstNumber }] : []),
    { label: "Balance date", value: `${lastDay} ${MONTHS[organisation.financialYearEndMonth - 1]}` },
  ];
  return {
    name: organisation.displayName,
    sections: [
      { title: "Details", lines: details },
      { title: "Directors, trustees and officers", lines: directory.officers },
      { title: "Advisers", lines: directory.advisers },
    ].filter((section) => section.lines.length > 0),
  };
}
