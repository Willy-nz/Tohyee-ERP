import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { AdminActor } from "@/lib/audit";
import { writeAdminAuditEvent } from "@/lib/audit";
import { privateAddress } from "@/lib/analytics/mail-host";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * Where an organisation's own settings may make this server connect: an
 * analytics database source, and a camera post box. These are typed by an
 * organisation's owner or admin, who on a server hosting several
 * organisations is trusted less than the server admin.
 *
 * - The internet: always.
 * - The local network (192.168.x.x, 10.x.x.x and the like): allowed unless a
 *   server admin turns it off. A database on the office network is the
 *   usual reason for a database source, so it stays on by default.
 * - This computer itself (localhost, its own addresses) and link-local
 *   addresses (which include cloud servers' metadata service): refused
 *   unless a server admin turns it on, for example for a database installed
 *   on the same computer as Tohyee.
 *
 * Every address a name resolves to is checked, each time it's used.
 */

const KEY = "organisation_network";

export type OrganisationNetwork = { localNetwork: boolean; thisComputer: boolean };
export const DEFAULT_ORGANISATION_NETWORK: OrganisationNetwork = { localNetwork: true, thisComputer: false };

export type AddressPlace = "internet" | "local_network" | "this_computer";

type Resolve = (host: string) => Promise<string[]>;
const resolveWithDns: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
let resolve: Resolve = resolveWithDns;
const interfaceAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => entry.address.toLowerCase());
let ownAddresses: () => string[] = interfaceAddresses;

let networkForTests: OrganisationNetwork | null = null;

/** Tests use made-up host names and addresses, and tests without the server's database can set the server admin's choice. */
export function setOrganisationReachForTests(next: { resolve?: Resolve | null; ownAddresses?: (() => string[]) | null; network?: OrganisationNetwork | null }): void {
  if (next.network !== undefined) networkForTests = next.network;
  if (next.resolve !== undefined) resolve = next.resolve ?? resolveWithDns;
  if (next.ownAddresses !== undefined) ownAddresses = next.ownAddresses ?? interfaceAddresses;
}

/** Where one address is. */
export function addressPlace(address: string, own: readonly string[] = ownAddresses()): AddressPlace {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (v4 && isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return "this_computer";
  }
  if (value === "::1" || value === "::" || /^fe[89ab][0-9a-f]?:/.test(value)) return "this_computer";
  if (own.includes(value) || (v4 && own.includes(v4))) return "this_computer";
  return privateAddress(value) ? "local_network" : "internet";
}

export async function getOrganisationNetwork(): Promise<OrganisationNetwork> {
  if (networkForTests) return networkForTests;
  // Without the server's database (unit tests) the defaults apply.
  const stored = await readServerSetting<Partial<OrganisationNetwork>, Record<string, never>>(KEY).catch(() => ({ value: {} as Partial<OrganisationNetwork> }));
  return {
    localNetwork: typeof stored.value.localNetwork === "boolean" ? stored.value.localNetwork : DEFAULT_ORGANISATION_NETWORK.localNetwork,
    thisComputer: typeof stored.value.thisComputer === "boolean" ? stored.value.thisComputer : DEFAULT_ORGANISATION_NETWORK.thisComputer,
  };
}

/** A server admin's choice (on the server computer). */
export async function saveOrganisationNetwork(actor: AdminActor, input: { localNetwork?: unknown; thisComputer?: unknown }): Promise<OrganisationNetwork> {
  const current = await getOrganisationNetwork();
  const next: OrganisationNetwork = {
    localNetwork: typeof input.localNetwork === "boolean" ? input.localNetwork : current.localNetwork,
    thisComputer: typeof input.thisComputer === "boolean" ? input.thisComputer : current.thisComputer,
  };
  await withCoreTransaction(async (client) => {
    await writeServerValue(client, KEY, next, actor.email);
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "server.organisation_network_updated",
      entityType: "server_setting",
      entityId: KEY,
      details: { before: current, after: next },
    });
  });
  return next;
}

/**
 * Checks that an organisation's setting may make this server connect to
 * `host`, and gives the addresses it resolved to (a caller can connect to
 * one of these, so the name can't answer differently a moment later).
 */
export async function assertOrganisationMayReach(host: string, what: string): Promise<string[]> {
  let addresses: string[];
  if (isIP(host.replace(/^\[|\]$/g, ""))) addresses = [host.replace(/^\[|\]$/g, "")];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new ValidationError(`Tohyee couldn't find a server called ${host}. Check the name, or use its IP address.`);
    }
    if (addresses.length === 0) throw new ValidationError(`Tohyee couldn't find a server called ${host}. Check the name, or use its IP address.`);
  }
  const allowed = await getOrganisationNetwork();
  const own = ownAddresses();
  for (const address of addresses) {
    const place = addressPlace(address, own);
    if (place === "this_computer" && !allowed.thisComputer) {
      throw new ValidationError(
        `${host} is this Tohyee server itself (or a link-local address), so ${what} can't use it. If that's intended, a server admin can allow it in Server settings › Remote access › Connections from organisations.`,
      );
    }
    if (place === "local_network" && !allowed.localNetwork) {
      throw new ValidationError(
        `${host} is on this server's local network, and a server admin has turned that off for ${what}. Ask them, or use an address on the internet.`,
      );
    }
  }
  return addresses;
}
