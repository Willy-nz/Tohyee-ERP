import { writeAdminAuditEvent } from "@/lib/audit";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { ACCOUNT_TYPES } from "@/lib/accounts/types";
import { requireGroup, type GroupUser } from "@/lib/consolidation/groups";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import { getOrganisation } from "@/lib/organisations/registry";
import { asRecord, requireArray, requireId, requireString } from "@/lib/validation";

/**
 * Chart mapping (CO16). Consolidated reports add accounts up by code. Where
 * a member's chart differs from the parent's, each of its accounts can be
 * sent to one of the parent's accounts of the same class, and it then adds
 * up on that line whatever its own code. An account with no map goes by its
 * own code, as before.
 */

export type AccountMap = { organisationId: string; accountId: string; parentAccountId: string };

export type MappingAccount = { id: string; code: string; name: string; accountClass: AccountClass; typeLabel: string; archived: boolean };

export type ChartMapping = {
  member: { organisationId: string; name: string };
  parent: { organisationId: string; name: string };
  /** The member's accounts, each with where it goes now. */
  accounts: Array<
    MappingAccount & {
      /** The parent's account it's sent to, or null to go by its own code. */
      mappedTo: string | null;
      /** A saved map that can't be used: the parent's account has gone or is a different class. */
      stale: boolean;
      /** The parent's account with the same code, when it has one of the same class. */
      sameCode: string | null;
    }
  >;
  parentAccounts: MappingAccount[];
};

export async function listAccountMaps(groupId: string): Promise<AccountMap[]> {
  const found = await coreQuery<{ organisation_id: string; account_id: string; parent_account_id: string }>(
    "select organisation_id, account_id::text, parent_account_id::text from consolidation_account_maps where group_id = $1",
    [groupId],
  );
  return found.rows.map((row) => ({ organisationId: row.organisation_id, accountId: row.account_id, parentAccountId: row.parent_account_id }));
}

async function accountsOf(user: GroupUser, organisationId: string): Promise<MappingAccount[]> {
  const record = (await getOrganisation(organisationId))!;
  return withOrganisationTransaction(
    record,
    { userId: user.id, email: user.email },
    async (tx) => {
      const found = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass; account_type: AccountType; is_active: boolean }>(
        "select a.id::text, a.code, a.name, a.account_class, a.account_type, a.is_active from accounts a order by a.code",
      );
      return found.rows.map((row) => ({ id: row.id, code: row.code, name: row.name, accountClass: row.account_class, typeLabel: ACCOUNT_TYPES[row.account_type].label, archived: !row.is_active }));
    },
    { readOnly: true },
  );
}

function memberOf(group: Awaited<ReturnType<typeof requireGroup>>, input: unknown) {
  const organisationId = requireString(input, "The organisation");
  const member = group.members.find((each) => each.organisationId === organisationId);
  if (!member) throw new ValidationError("That organisation isn't in this group.");
  if (organisationId === group.parentOrganisationId) throw new ValidationError("The parent's chart is the one the others are mapped to, so it has no mapping of its own.");
  return member;
}

/** A member's accounts and where each goes on the group's reports. Anyone who can see the group. */
export async function getChartMapping(user: GroupUser, groupIdInput: unknown, organisationIdInput: unknown): Promise<ChartMapping> {
  const group = await requireGroup(user, groupIdInput);
  const member = memberOf(group, organisationIdInput);
  const parent = group.members.find((each) => each.organisationId === group.parentOrganisationId)!;
  const [accounts, parentAccounts, maps] = await Promise.all([accountsOf(user, member.organisationId), accountsOf(user, parent.organisationId), listAccountMaps(group.id)]);
  const parentById = new Map(parentAccounts.map((account) => [account.id, account]));
  const parentByCode = new Map(parentAccounts.map((account) => [account.code.toLowerCase(), account]));
  const mapped = new Map(maps.filter((map) => map.organisationId === member.organisationId).map((map) => [map.accountId, map.parentAccountId]));
  return {
    member: { organisationId: member.organisationId, name: member.name },
    parent: { organisationId: parent.organisationId, name: parent.name },
    accounts: accounts.map((account) => {
      const target = mapped.get(account.id);
      const fits = target !== undefined && parentById.get(target)?.accountClass === account.accountClass;
      const same = parentByCode.get(account.code.toLowerCase());
      return { ...account, mappedTo: fits ? target : null, stale: target !== undefined && !fits, sameCode: same && same.accountClass === account.accountClass ? same.id : null };
    }),
    parentAccounts,
  };
}

/**
 * Saves where a member's accounts go: `{ organisationId, maps: [{ accountId,
 * parentAccountId }] }`, with a null `parentAccountId` to go back to the
 * account's own code. Only the accounts named change. Admins of every
 * organisation, as for the group's rates.
 */
export async function setChartMapping(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<ChartMapping> {
  const group = await requireGroup(user, groupIdInput, "admin");
  const member = memberOf(group, input.organisationId);
  const [accounts, parentAccounts] = await Promise.all([accountsOf(user, member.organisationId), accountsOf(user, group.parentOrganisationId)]);
  const own = new Map(accounts.map((account) => [account.id, account]));
  const parents = new Map(parentAccounts.map((account) => [account.id, account]));
  const changes = requireArray(input.maps, "maps", 2000).map((raw) => {
    const entry = asRecord(raw, "A mapping");
    const account = own.get(requireId(entry.accountId, "accountId"));
    if (!account) throw new ValidationError(`${member.name} has no such account.`);
    if (entry.parentAccountId === null || entry.parentAccountId === undefined || entry.parentAccountId === "") return { account, target: null };
    const target = parents.get(requireId(entry.parentAccountId, "parentAccountId"));
    if (!target) throw new ValidationError(`The parent has no such account to send ${account.code} ${account.name} to.`);
    if (target.accountClass !== account.accountClass) {
      throw new ValidationError(`${account.code} ${account.name} is ${article(account.accountClass)} account and ${target.code} ${target.name} is ${article(target.accountClass)} account. An account can only go to one of the same kind.`);
    }
    return { account, target };
  });
  await withCoreTransaction(async (client) => {
    for (const change of changes) {
      if (change.target === null) {
        await client.query("delete from consolidation_account_maps where group_id = $1 and organisation_id = $2 and account_id = $3", [group.id, member.organisationId, change.account.id]);
      } else {
        await client.query(
          `insert into consolidation_account_maps (group_id, organisation_id, account_id, parent_account_id, changed_by_email) values ($1, $2, $3, $4, $5)
           on conflict (group_id, organisation_id, account_id) do update set parent_account_id = excluded.parent_account_id, changed_by_email = excluded.changed_by_email, changed_at = now()`,
          [group.id, member.organisationId, change.account.id, change.target.id, user.email],
        );
      }
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_chart_mapping.changed",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { organisationId: member.organisationId, maps: changes.map((change) => ({ account: change.account.code, to: change.target?.code ?? null })) },
    });
  });
  return getChartMapping(user, group.id, member.organisationId);
}

function article(accountClass: AccountClass): string {
  return accountClass === "asset" || accountClass === "equity" || accountClass === "expense" ? `an ${accountClass}` : `a ${accountClass}`;
}
