"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./directory-card.module.css";
import { DIRECTORY_LIMITS, type DirectoryLine, type OrganisationDirectory } from "@/lib/organisations/directory";

type ListKey = "numbers" | "officers" | "advisers";

const LISTS: Array<{ key: ListKey; title: string; hint: string; label: string; value: string; labelHint: string; add: string }> = [
  { key: "numbers", title: "Registration numbers", hint: "NZBN, company number, charity registration number.", label: "What it is", value: "Number", labelHint: "NZBN", add: "Add a number" },
  { key: "officers", title: "Directors, trustees or officers", hint: "Whoever governs the organisation, with their role.", label: "Role", value: "Name", labelHint: "Director", add: "Add a person" },
  { key: "advisers", title: "Advisers", hint: "Accountant, bank, solicitor, auditor.", label: "What they are", value: "Who", labelHint: "Accountant", add: "Add an adviser" },
];

/**
 * Settings › Directory: the details a printed report's
 * directory page shows, kept once here. The name, postal address, GST number
 * and balance date come from the settings above.
 */
export function DirectoryCard({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ directory: OrganisationDirectory }>(`/api/organisations/${organisationId}/directory`);
  // Kept here, not in the form: the form starts afresh from what was saved.
  const [saved, setSaved] = useState(false);
  return (
    <Card
      title="Directory"
      description="For the directory page of printed reports (Analytics › a report › Add item › Directory). The name, postal address, GST number and balance date come from the settings above."
    >
      <div id="directory">
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {saved ? <Notice tone="success">Directory saved.</Notice> : null}
        {loaded.data ? (
          <DirectoryForm
            key={JSON.stringify(loaded.data.directory)}
            organisationId={organisationId}
            directory={loaded.data.directory}
            onChanged={() => setSaved(false)}
            onSaved={() => {
              setSaved(true);
              loaded.reload();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

function DirectoryForm({ organisationId, directory, onSaved, onChanged }: { organisationId: string; directory: OrganisationDirectory; onSaved: () => void; onChanged: () => void }) {
  const [office, setOffice] = useState(directory.registeredOffice ?? "");
  const [lists, setLists] = useState<Record<ListKey, DirectoryLine[]>>({ numbers: directory.numbers, officers: directory.officers, advisers: directory.advisers });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const change = (key: ListKey, next: DirectoryLine[]) => {
    onChanged();
    setLists((current) => ({ ...current, [key]: next }));
  };
  const save = async () => {
    setSaving(true);
    setFailed(null);
    try {
      await api(`/api/organisations/${organisationId}/directory`, { method: "PUT", body: { directory: { registeredOffice: office.trim() || null, ...lists } } });
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {failed ? <Notice tone="error">{failed}</Notice> : null}
      <Field label="Registered office" hint="Leave blank if it's the postal address.">
        <textarea
          rows={2}
          maxLength={DIRECTORY_LIMITS.registeredOffice}
          value={office}
          onChange={(event) => {
            onChanged();
            setOffice(event.target.value);
          }}
        />
      </Field>
      {LISTS.map((list) => (
        <section key={list.key} aria-label={list.title} className={styles.list}>
          <h3>{list.title}</h3>
          <p className={ui.muted}>{list.hint}</p>
          {lists[list.key].map((line, index) => (
            <div key={index} className={styles.row}>
              <Field label={`${list.label} ${index + 1}`}>
                <input
                  maxLength={DIRECTORY_LIMITS.label}
                  placeholder={list.labelHint}
                  value={line.label}
                  onChange={(event) => change(list.key, lists[list.key].map((entry, at) => (at === index ? { ...entry, label: event.target.value } : entry)))}
                />
              </Field>
              <Field label={list.value}>
                <input
                  maxLength={DIRECTORY_LIMITS.value}
                  value={line.value}
                  onChange={(event) => change(list.key, lists[list.key].map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))}
                />
              </Field>
              <div>
                <Button type="button" variant="secondary" size="small" onClick={() => change(list.key, lists[list.key].filter((_, at) => at !== index))}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
          {lists[list.key].length < DIRECTORY_LIMITS[list.key] ? (
            <Button type="button" variant="secondary" size="small" onClick={() => change(list.key, [...lists[list.key], { label: "", value: "" }])}>
              {list.add}
            </Button>
          ) : null}
        </section>
      ))}
      <div className={ui.actions}>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save directory"}
        </Button>
      </div>
    </form>
  );
}
