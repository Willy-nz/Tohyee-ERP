"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, apiDownload, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { DATE_RANGES, OPERATORS } from "@/lib/saved-searches/catalogue";
import { startFromAddress } from "@/lib/saved-searches/from-list";
import type { PublicRecordType as RecordType } from "@/lib/saved-searches/org-catalogue";
import type {
  SearchDefinition,
  SearchFilter,
} from "@/lib/saved-searches/query";
import type { SavedSearch, SearchResult } from "@/lib/saved-searches/service";
import styles from "./saved-searches.module.css";

/**
 * Reports › Saved searches: pick a kind of record, filter it, choose the
 * columns, and keep it under a name. It reads the live books each time.
 * `?search=<id>` opens a saved one; `?type=invoice` starts a new one.
 */

type Draft = {
  id: string | null;
  type: RecordType;
  name: string;
  shared: boolean;
  onHome: boolean;
  definition: SearchDefinition;
};

function fieldOf(type: RecordType, key: string) {
  return type.fields.find((field) => field.key === key) ?? null;
}

/** A new search, begun from a list's "Save this view" when the address carries one; anything this kind of record doesn't have is left off. */
function startedFrom(type: RecordType, start: string | null): Draft {
  const draft = blank(type);
  const from = startFromAddress(start);
  if (!from) return draft;
  const filters = from.filters.filter((filter) => {
    const field = fieldOf(type, filter.field);
    return (
      field !== null &&
      OPERATORS[field.type].some((each) => each.op === filter.op)
    );
  });
  const sort = from.sort && fieldOf(type, from.sort.field) ? from.sort : null;
  return { ...draft, definition: { ...draft.definition, filters, sort } };
}

function blank(type: RecordType): Draft {
  return {
    id: null,
    type,
    name: "",
    shared: false,
    onHome: false,
    definition: { filters: [], columns: [...type.defaultColumns], sort: null },
  };
}

/** A filter that's ready to send: its value boxes are filled in. Half-typed ones wait. */
function complete(type: RecordType, filter: SearchFilter): boolean {
  const field = fieldOf(type, filter.field);
  const operator = field
    ? OPERATORS[field.type].find((each) => each.op === filter.op)
    : null;
  if (!operator) return false;
  if (operator.values >= 1 && !filter.value?.trim()) return false;
  if (operator.values === 2 && !filter.value2?.trim()) return false;
  return true;
}

function sendable(draft: Draft): SearchDefinition {
  return {
    ...draft.definition,
    filters: draft.definition.filters.filter((filter) =>
      complete(draft.type, filter),
    ),
  };
}

export function SavedSearches({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const saved = useApiData<{
    searches: SavedSearch[];
    recordTypes: RecordType[];
  }>("/api/saved-searches", {
    organisationId,
  });
  const [message, setMessage] = useState<string | null>(null);
  const searches = saved.data?.searches ?? null;
  const wantedId = params.get("search");
  const recordTypes = saved.data?.recordTypes ?? [];
  const recordType = (key: string | null) =>
    recordTypes.find((type) => type.key === key) ?? null;
  const wantedType = recordType(params.get("type"));

  if (saved.error) return <Notice tone="error">{saved.error}</Notice>;
  if (!searches) return <p className={ui.muted}>Loading…</p>;

  // What the address asks for: a saved search, or a new one of some kind.
  const found = wantedId
    ? (searches.find((search) => search.id === wantedId) ?? null)
    : null;
  const foundType = found ? recordType(found.recordType) : null;
  const initial: Draft | null =
    found && foundType
      ? {
          id: found.id,
          type: foundType,
          name: found.name,
          shared: found.shared,
          onHome: found.onHome,
          definition: found.definition,
        }
      : !wantedId && wantedType
        ? startedFrom(wantedType, params.get("start"))
        : null;

  return (
    <div className={ui.stack}>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {wantedId && !found ? (
        <Notice tone="warning">
          That saved search isn&apos;t there any more, or isn&apos;t shared with
          you.
        </Notice>
      ) : null}

      <Card
        title="Your searches"
        description="A search is a list you've filtered and kept. It always shows what's in the books now."
      >
        {searches.length === 0 ? (
          <p className={ui.muted}>None saved yet. Start one below.</p>
        ) : null}
        <div className={styles.chips}>
          {searches.map((search) => (
            <Link
              key={search.id}
              href={`/operations/saved-searches?search=${search.id}`}
              className={`${styles.chip} ${initial?.id === search.id ? styles.chipOn : ""}`}
            >
              {search.name}
              <span className={ui.muted}>
                {" "}
                · {search.recordLabel}
                {search.shared ? " · shared" : ""}
              </span>
            </Link>
          ))}
        </div>
        <div className={styles.starts}>
          <span className={ui.muted}>New search of</span>
          {recordTypes.map((type) => (
            <Button
              key={type.key}
              size="small"
              variant="secondary"
              onClick={() =>
                router.push(`/operations/saved-searches?type=${type.key}`)
              }
            >
              {type.label}
            </Button>
          ))}
        </div>
      </Card>

      {initial ? (
        <Editor
          key={
            initial.id
              ? `s:${initial.id}:${found?.updatedAt ?? ""}`
              : `t:${initial.type.key}:${params.get("start") ?? ""}`
          }
          organisationId={organisationId}
          initial={initial}
          current={found}
          onSaved={(search) => {
            setMessage(`${search.name} saved.`);
            saved.reload();
            router.replace(`/operations/saved-searches?search=${search.id}`);
          }}
          onDeleted={(name) => {
            setMessage(`${name} deleted.`);
            saved.reload();
            router.replace("/operations/saved-searches");
          }}
        />
      ) : null}
    </div>
  );
}

function Editor({
  organisationId,
  initial,
  current,
  onSaved,
  onDeleted,
}: {
  organisationId: string;
  initial: Draft;
  current: SavedSearch | null;
  onSaved: (search: SavedSearch) => void;
  onDeleted: (name: string) => void;
}) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft>(initial);
  // The answer, and which search it's the answer to: while they differ, a search is on its way.
  const [answer, setAnswer] = useState<{
    key: string;
    result: SearchResult;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showColumns, setShowColumns] = useState(false);

  const definitionKey = JSON.stringify([draft.type.key, sendable(draft)]);
  useEffect(() => {
    let stale = false;
    // A short wait, so typing a value doesn't search on every key.
    const timer = setTimeout(() => {
      const [type, definition] = JSON.parse(definitionKey) as [
        string,
        SearchDefinition,
      ];
      api<{ result: SearchResult }>("/api/saved-searches/run", {
        method: "POST",
        body: { organisationId, recordType: type, definition },
      })
        .then((got) => {
          if (stale) return;
          setAnswer({ key: definitionKey, result: got.result });
          setError(null);
        })
        .catch((caught) => {
          if (!stale) setError(errorMessage(caught));
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [definitionKey, organisationId]);
  const result = answer?.result ?? null;
  const running = answer?.key !== definitionKey;

  const canEdit = !current || current.canEdit;

  function change(next: Partial<SearchDefinition>) {
    setDraft({ ...draft, definition: { ...draft.definition, ...next } });
  }

  async function save(asNew: boolean) {
    setBusy(true);
    setError(null);
    try {
      const got = await api<{ search: SavedSearch }>("/api/saved-searches", {
        method: "POST",
        body: {
          organisationId,
          ...(asNew || !draft.id
            ? { recordType: draft.type.key }
            : { id: draft.id }),
          name: draft.name,
          shared: draft.shared,
          onHome: draft.onHome,
          definition: sendable(draft),
        },
      });
      onSaved(got.search);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !draft?.id ||
      !(await confirm(
        `Delete the saved search "${draft.name}"? Nothing in the books changes.`,
      ))
    )
      return;
    setBusy(true);
    try {
      await api(
        `/api/saved-searches/${draft.id}?organisationId=${encodeURIComponent(organisationId)}`,
        { method: "DELETE" },
      );
      onDeleted(draft.name);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    try {
      const blob = await apiDownload("/api/saved-searches/export", {
        organisationId,
        recordType: draft.type.key,
        name: draft.name,
        definition: sendable(draft),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${draft.name.trim() || draft.type.label}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={
          draft.id
            ? draft.name
            : `New search of ${draft.type.label.toLowerCase()}`
        }
      >
        <div className={ui.stack}>
          <Filters draft={draft} onChange={(filters) => change({ filters })} />
          <div className={styles.sortRow}>
            <Field label="Sort by">
              <select
                value={
                  draft.definition.sort?.field ?? draft.type.defaultSort.field
                }
                onChange={(event) =>
                  change({
                    sort: {
                      field: event.target.value,
                      direction:
                        draft.definition.sort?.direction ??
                        draft.type.defaultSort.direction,
                    },
                  })
                }
              >
                {draft.type.fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Order">
              <select
                value={
                  draft.definition.sort?.direction ??
                  draft.type.defaultSort.direction
                }
                onChange={(event) =>
                  change({
                    sort: {
                      field:
                        draft.definition.sort?.field ??
                        draft.type.defaultSort.field,
                      direction: event.target.value === "asc" ? "asc" : "desc",
                    },
                  })
                }
              >
                <option value="asc">Smallest or earliest first</option>
                <option value="desc">Biggest or latest first</option>
              </select>
            </Field>
            <button
              type="button"
              className={styles.linkButton}
              aria-expanded={showColumns}
              onClick={() => setShowColumns(!showColumns)}
            >
              {showColumns
                ? "Hide columns"
                : `Columns (${draft.definition.columns.length})`}
            </button>
          </div>
          {showColumns ? (
            <div className={styles.columns}>
              {draft.type.fields.map((field) => {
                const on = draft.definition.columns.includes(field.key);
                return (
                  <label key={field.key}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={on && draft.definition.columns.length === 1}
                      onChange={() =>
                        // Columns stay in the record's own order, whichever was ticked last.
                        change({
                          columns: draft.type.fields
                            .map((each) => each.key)
                            .filter((key) =>
                              key === field.key
                                ? !on
                                : draft.definition.columns.includes(key),
                            ),
                        })
                      }
                    />{" "}
                    {field.label}
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title={draft.id ? "Keep changes" : "Keep this search"}>
        <div className={styles.saveRow}>
          <Field label="Name">
            <input
              value={draft.name}
              maxLength={80}
              placeholder="Overdue more than 60 days"
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </Field>
          {can("bookkeeper") ? (
            <label className={styles.share}>
              <input
                type="checkbox"
                checked={draft.shared}
                onChange={(event) =>
                  setDraft({ ...draft, shared: event.target.checked })
                }
              />{" "}
              Share with everyone who can see the books
            </label>
          ) : null}
          <label className={styles.share}>
            <input
              type="checkbox"
              checked={draft.onHome}
              onChange={(event) =>
                setDraft({ ...draft, onHome: event.target.checked })
              }
            />{" "}
            {draft.shared ? "Show on everyone's Home" : "Show on my Home"}
          </label>
        </div>
        {current && !current.canEdit ? (
          <p className={ui.muted}>
            {current.ownerEmail} made this one. You can save your own copy.
          </p>
        ) : null}
        <div className={styles.starts}>
          {draft.id && canEdit ? (
            <Button
              disabled={busy || !draft.name.trim()}
              onClick={() => void save(false)}
            >
              Save
            </Button>
          ) : null}
          <Button
            variant={draft.id && canEdit ? "secondary" : "primary"}
            disabled={busy || !draft.name.trim()}
            onClick={() => void save(true)}
          >
            {draft.id ? "Save as a new search" : "Save"}
          </Button>
          {draft.id && canEdit ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </Card>

      {current ? (
        <EmailMe
          key={`${current.id}:${current.myEmail?.frequency ?? ""}:${current.myEmail?.onlyWhen ?? ""}`}
          organisationId={organisationId}
          search={current}
          onSaved={onSaved}
          onError={setError}
        />
      ) : null}

      <Card
        title={
          result
            ? `${result.matches} ${result.matches === 1 ? draft.type.singular : `${draft.type.singular}s`}`
            : "Results"
        }
      >
        {!result ? (
          <p className={ui.muted}>Searching…</p>
        ) : result.rows.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <Results result={result} running={running} />
        )}
        {result && result.nextOffset !== null ? (
          <p className={ui.muted}>
            Showing the first {result.rows.length}. Download the file for up to
            5,000, or narrow the search.
          </p>
        ) : null}
        {result && result.rows.length > 0 ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void download()}
          >
            Download as a file
          </button>
        ) : null}
      </Card>
    </>
  );
}

function Filters({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (filters: SearchFilter[]) => void;
}) {
  const filters = draft.definition.filters;
  const set = (index: number, next: SearchFilter) =>
    onChange(filters.map((filter, at) => (at === index ? next : filter)));
  return (
    <div className={styles.filters}>
      {filters.length === 0 ? (
        <p className={ui.muted}>No filters: everything shows.</p>
      ) : null}
      {filters.map((filter, index) => {
        const field = fieldOf(draft.type, filter.field) ?? draft.type.fields[0];
        const operators = OPERATORS[field.type];
        const operator =
          operators.find((each) => each.op === filter.op) ?? operators[0];
        const input = (which: "value" | "value2") => {
          const value = filter[which] ?? "";
          const update = (text: string) =>
            set(index, { ...filter, [which]: text });
          if (field.type === "choice") {
            return (
              <select
                aria-label="Value"
                value={value}
                onChange={(event) => update(event.target.value)}
              >
                <option value="">Choose</option>
                {field.choices?.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            );
          }
          if (field.type === "date" && operator.op === "within") {
            return (
              <select
                aria-label="Range"
                value={value}
                onChange={(event) => update(event.target.value)}
              >
                <option value="">Choose</option>
                {DATE_RANGES.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </select>
            );
          }
          if (field.type === "date")
            return (
              <DateInput
                aria-label={which === "value" ? "Date" : "Second date"}
                value={value}
                onChange={(event) => update(event.target.value)}
              />
            );
          return (
            <input
              aria-label={which === "value" ? "Value" : "Second value"}
              inputMode={field.type === "text" ? "text" : "decimal"}
              value={value}
              onChange={(event) => update(event.target.value)}
            />
          );
        };
        return (
          <div key={index} className={styles.filter}>
            <select
              aria-label="Field"
              value={field.key}
              onChange={(event) => {
                const next = fieldOf(draft.type, event.target.value)!;
                set(index, { field: next.key, op: OPERATORS[next.type][0].op });
              }}
            >
              {draft.type.fields.map((each) => (
                <option key={each.key} value={each.key}>
                  {each.label}
                </option>
              ))}
            </select>
            <select
              aria-label="How"
              value={operator.op}
              onChange={(event) =>
                set(index, {
                  field: field.key,
                  op: event.target.value,
                  value: field.type === "date" ? "" : filter.value,
                })
              }
            >
              {operators.map((each) => (
                <option key={each.op} value={each.op}>
                  {each.label}
                </option>
              ))}
            </select>
            {operator.values >= 1 ? input("value") : null}
            {operator.values === 2 ? (
              <>
                <span className={ui.muted}>and</span>
                {input("value2")}
              </>
            ) : null}
            <Button
              size="small"
              variant="secondary"
              onClick={() => onChange(filters.filter((_, at) => at !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          size="small"
          variant="secondary"
          disabled={filters.length >= 12}
          onClick={() =>
            onChange([
              ...filters,
              {
                field: draft.type.fields[0].key,
                op: OPERATORS[draft.type.fields[0].type][0].op,
              },
            ])
          }
        >
          Add a filter
        </Button>
      </div>
    </div>
  );
}

function Results({
  result,
  running,
}: {
  result: SearchResult;
  running: boolean;
}) {
  function cell(value: string | null, index: number) {
    const column = result.columns[index];
    if (value === null || value === "") return "";
    if (column.type === "money") return <Money value={value} />;
    if (column.type === "date") return formatDate(value);
    if (column.type === "choice") return column.choices?.[value] ?? value;
    return value;
  }
  const numeric = (index: number) =>
    result.columns[index].type === "money" ||
    result.columns[index].type === "number";
  return (
    <div className={ui.tableWrap} aria-busy={running}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            {result.columns.map((column, index) => (
              <th
                key={column.key}
                className={numeric(index) ? ui.num : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((value, index) => (
                <td
                  key={index}
                  data-label={result.columns[index].label}
                  className={numeric(index) ? ui.num : undefined}
                >
                  {index === 0 ? (
                    <Link href={row.href}>{cell(value, index) || "Open"}</Link>
                  ) : (
                    cell(value, index)
                  )}
                </td>
              ))}
            </tr>
          ))}
          {result.totals.some((total) => total !== null) ? (
            <tr className={ui.reportTotal}>
              {result.totals.map((total, index) => (
                <td
                  key={index}
                  data-label={result.columns[index].label}
                  className={numeric(index) ? ui.num : undefined}
                >
                  {total !== null ? (
                    <Money value={total} />
                  ) : index === 0 ? (
                    "Total of all that match"
                  ) : (
                    ""
                  )}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** "Email me this": the person's own choice for a saved search, kept as soon as it's changed. */
function EmailMe({
  organisationId,
  search,
  onSaved,
  onError,
}: {
  organisationId: string;
  search: SavedSearch;
  onSaved: (search: SavedSearch) => void;
  onError: (text: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const frequency = search.myEmail?.frequency ?? "never";
  const onlyWhen = search.myEmail?.onlyWhen ?? "always";
  async function set(next: { frequency: string; onlyWhen: string }) {
    setBusy(true);
    onError(null);
    try {
      const got = await api<{ search: SavedSearch }>(
        `/api/saved-searches/${search.id}/email`,
        { method: "PUT", body: { organisationId, ...next } },
      );
      onSaved(got.search);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Email me this"
      description="Sent to your own email in the morning. It needs email set up on the server."
    >
      <div className={styles.saveRow}>
        <Field label="How often">
          <select
            value={frequency}
            disabled={busy}
            onChange={(event) =>
              void set({ frequency: event.target.value, onlyWhen })
            }
          >
            <option value="never">Never</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week, on Monday</option>
            <option value="monthly">Every month, on the 1st</option>
          </select>
        </Field>
        {frequency !== "never" ? (
          <Field label="When">
            <select
              value={onlyWhen}
              disabled={busy}
              onChange={(event) =>
                void set({ frequency, onlyWhen: event.target.value })
              }
            >
              <option value="always">Every time</option>
              <option value="has_rows">
                Only when there&apos;s something in it
              </option>
              <option value="new_rows">
                Only when there&apos;s something new in it
              </option>
            </select>
          </Field>
        ) : null}
      </div>
    </Card>
  );
}
