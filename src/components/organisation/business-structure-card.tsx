"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { ENTITY_TYPE_LABELS, ENTITY_TYPES, type EntityType, formatIrdNumber } from "@/lib/organisations/entity-types";

type Structure = { entityType: EntityType | null; irdNumber: string | null };

/**
 * Settings › Business structure (ENT1-ENT8): what kind of entity this is and
 * its IRD number. Year-end notes, income tax, the directory page and
 * payroll's employer IRD number follow it.
 */
export function BusinessStructureCard({ organisationId, onSaved }: { organisationId: string; onSaved?: () => void }) {
  const loaded = useApiData<{ structure: Structure }>(`/api/organisations/${organisationId}/business-structure`);
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Business structure" description="Year-end notes, income tax and the directory page follow it. Nothing already posted changes.">
      <div id="business-structure">
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {saved ? <Notice tone="success">Business structure saved.</Notice> : null}
        {loaded.data ? (
          <StructureForm
            key={JSON.stringify(loaded.data.structure)}
            organisationId={organisationId}
            structure={loaded.data.structure}
            onChanged={() => setSaved(false)}
            onSaved={() => {
              setSaved(true);
              loaded.reload();
              onSaved?.();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

function StructureForm({ organisationId, structure, onSaved, onChanged }: { organisationId: string; structure: Structure; onSaved: () => void; onChanged: () => void }) {
  const [entityType, setEntityType] = useState<EntityType | "">(structure.entityType ?? "");
  const [irdNumber, setIrdNumber] = useState(structure.irdNumber ? formatIrdNumber(structure.irdNumber) : "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setFailed(null);
    try {
      await api(`/api/organisations/${organisationId}/business-structure`, { method: "PUT", body: { entityType: entityType || null, irdNumber: irdNumber.trim() || null } });
      onSaved();
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className={ui.inlineForm}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {failed ? <Notice tone="error">{failed}</Notice> : null}
      <Field label="Entity type">
        <select
          value={entityType}
          onChange={(event) => {
            onChanged();
            setEntityType(event.target.value as EntityType | "");
          }}
        >
          <option value="">Not chosen</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {ENTITY_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="IRD number" hint="Optional. Usually the same as the GST number.">
        <input
          inputMode="numeric"
          maxLength={20}
          placeholder="123-456-789"
          value={irdNumber}
          onChange={(event) => {
            onChanged();
            setIrdNumber(event.target.value);
          }}
        />
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
