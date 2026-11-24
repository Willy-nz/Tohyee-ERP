"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { ChartMapping } from "@/lib/consolidation/mapping";
import type { ConsolidationGroup } from "@/lib/consolidation/types";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Chart mapping (CO16): for each organisation other than the parent, which
 * of the parent's accounts each of its accounts adds up on. Left alone, an
 * account goes by its own code.
 */
export function ChartMappingTab({ group, canAdmin }: { group: ConsolidationGroup; canAdmin: boolean }) {
  const others = group.members.filter((member) => member.organisationId !== group.parentOrganisationId);
  const [member, setMember] = useState(others[0]?.organisationId ?? "");
  const loaded = useApiData<{ mapping: ChartMapping }>(member ? `/api/consolidation/groups/${group.id}/chart-mapping` : null, { member });
  if (others.length === 0) return <Empty>This group has only its parent, so there&apos;s nothing to map.</Empty>;
  return (
    <Card title="Chart mapping">
      <p className={ui.muted}>
        The group&apos;s reports add accounts up by code. Where an organisation&apos;s chart of accounts is different from the parent&apos;s, send each of its accounts to the parent&apos;s account it belongs with. An account you leave alone
        goes by its own code.
      </p>
      {others.length > 1 ? (
        <Field label="Organisation">
          <select value={member} onChange={(event) => setMember(event.target.value)}>
            {others.map((each) => (
              <option key={each.organisationId} value={each.organisationId}>
                {each.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {loaded.data ? (
        <Mapping key={`${member}-${stamp(loaded.data.mapping)}`} groupId={group.id} mapping={loaded.data.mapping} canAdmin={canAdmin} onSaved={loaded.reload} />
      ) : loaded.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}

/** Changes when what's saved changes, so the editor starts again from it. */
function stamp(mapping: ChartMapping): string {
  return mapping.accounts.map((account) => `${account.id}:${account.mappedTo ?? ""}`).join(",");
}

function Mapping({ groupId, mapping, canAdmin, onSaved }: { groupId: string; mapping: ChartMapping; canAdmin: boolean; onSaved: () => void }) {
  // What's been chosen and not yet saved: an account id to the parent's account id, or "" for its own code.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const parents = new Map(mapping.parentAccounts.map((account) => [account.id, account]));
  const chosen = (account: ChartMapping["accounts"][number]) => (account.id in draft ? draft[account.id] : (account.mappedTo ?? ""));
  // An account needs a look when nothing says where it goes: no map, and the parent has no account with its code.
  const open = (account: ChartMapping["accounts"][number]) => chosen(account) === "" && account.sameCode === null && !account.archived;
  const needLook = mapping.accounts.filter(open);
  const changed = mapping.accounts.filter((account) => account.id in draft && draft[account.id] !== (account.mappedTo ?? ""));
  const words = search.trim().toLowerCase();
  const shown = mapping.accounts.filter(
    (account) => (!onlyOpen || open(account) || account.id in draft || account.stale) && (!words || `${account.code} ${account.name}`.toLowerCase().includes(words)),
  );

  function suggest() {
    const next = { ...draft };
    let found = 0;
    for (const account of needLook) {
      const match = mapping.parentAccounts.filter((parent) => !parent.archived && parent.accountClass === account.accountClass && parent.name.trim().toLowerCase() === account.name.trim().toLowerCase());
      if (match.length !== 1) continue;
      next[account.id] = match[0].id;
      found += 1;
    }
    setDraft(next);
    setSaid(found ? `Matched ${found} by name. Check them, then save.` : "No more accounts match one of the parent's by name.");
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      await api(`/api/consolidation/groups/${groupId}/chart-mapping`, {
        method: "PUT",
        body: { organisationId: mapping.member.organisationId, maps: changed.map((account) => ({ accountId: account.id, parentAccountId: draft[account.id] || null })) },
      });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        {needLook.length === 0 ? (
          <>
            Every account in <strong>{mapping.member.name}</strong> has somewhere to go.
          </>
        ) : (
          <>
            <strong>
              {needLook.length} of {mapping.accounts.length}
            </strong>{" "}
            accounts in {mapping.member.name} have no account with the same code in {mapping.parent.name}. Until they&apos;re mapped, each shows on a line of its own.
          </>
        )}
      </p>
      <div className={ui.toolbar}>
        <Field label="Find an account">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Code or name" />
        </Field>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} /> Only the ones to look at
        </label>
        {canAdmin && needLook.length > 0 ? (
          <Button variant="secondary" onClick={suggest}>
            Match by name
          </Button>
        ) : null}
      </div>
      {said ? <Notice tone="info">{said}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canAdmin ? <p className={ui.muted}>Only someone who&apos;s an admin or owner of every organisation in the group can change the mapping.</p> : null}
      {shown.length === 0 ? (
        <Empty>{onlyOpen && !words ? "Nothing to look at. Untick “Only the ones to look at” to see every account." : "No accounts match."}</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>{mapping.member.name}&apos;s account</th>
                <th>Adds up on, in {mapping.parent.name}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((account) => {
                const same = account.sameCode ? parents.get(account.sameCode) : undefined;
                const value = chosen(account);
                const differs = value === "" && same && same.name.trim().toLowerCase() !== account.name.trim().toLowerCase();
                return (
                  <tr key={account.id}>
                    <td data-label="Account">
                      {account.code} {account.name} <span className={ui.muted}>({account.typeLabel})</span> {account.archived ? <Badge tone="neutral">Archived</Badge> : null}
                    </td>
                    <td data-label={`Adds up on, in ${mapping.parent.name}`}>
                      <select aria-label={`Where ${account.code} ${account.name} adds up`} value={value} disabled={!canAdmin || busy} onChange={(event) => setDraft({ ...draft, [account.id]: event.target.value })}>
                        <option value="">{same ? `Same code: ${same.code} ${same.name}` : "A line of its own"}</option>
                        {mapping.parentAccounts
                          .filter((parent) => parent.accountClass === account.accountClass && (!parent.archived || parent.id === value))
                          .map((parent) => (
                            <option key={parent.id} value={parent.id}>
                              {parent.code} {parent.name}
                            </option>
                          ))}
                      </select>
                      {differs ? <div className={ui.muted}>Same code, different name. Check it&apos;s the same thing.</div> : null}
                      {account.stale && !(account.id in draft) ? <div className={ui.muted}>It was mapped to an account that&apos;s gone or changed kind. Choose again.</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canAdmin ? (
        <div className={ui.toolbar}>
          <Button onClick={save} disabled={busy || changed.length === 0}>
            {changed.length ? `Save ${changed.length} ${changed.length === 1 ? "change" : "changes"}` : "Save"}
          </Button>
          {changed.length ? (
            <Button variant="secondary" disabled={busy} onClick={() => setDraft({})}>
              Undo changes
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
