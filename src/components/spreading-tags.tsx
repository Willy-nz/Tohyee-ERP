"use client";

import { CustomFieldInputs, customValuesText, useCustomFields, visibleFields } from "@/components/custom-fields";
import { activeCategories, TrackingSelects, trackingText, useTracking } from "@/components/tracking";
import { Field, ui } from "@/components/ui";
import type { CustomFieldSetup, CustomValues } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

/**
 * Tracking and journal-line custom fields for a Spreading item (example
 * SW25): what each month's income or expense line carries. Nothing shows in
 * an organisation that has neither.
 */

export type TagSetups = { tracking: TrackingSetup | null; custom: CustomFieldSetup | null; any: boolean };

export function useTagSetups(organisationId: string): TagSetups {
  const tracking = useTracking(organisationId).data ?? null;
  const custom = useCustomFields(organisationId).data ?? null;
  return { tracking, custom, any: activeCategories(tracking).length > 0 || visibleFields(custom, "line", ["journal"]).length > 0 };
}

export type ItemTags = { tracking: TrackingTags; customFields: CustomValues };

export function ItemTagInputs({ setups, value, onChange, disabled }: { setups: TagSetups; value: ItemTags; onChange: (value: ItemTags) => void; disabled?: boolean }) {
  if (!setups.any && Object.keys(value.tracking).length === 0 && Object.keys(value.customFields).length === 0) return null;
  return (
    <Field label="Tracking and custom fields" hint="These go on each month's journal line. Changing them later only affects months not yet posted.">
      <TrackingSelects setup={setups.tracking} value={value.tracking} onChange={(tracking) => onChange({ ...value, tracking })} disabled={disabled} />
      <CustomFieldInputs setup={setups.custom} record="line" uses={["journal"]} value={value.customFields} onChange={(customFields) => onChange({ ...value, customFields })} disabled={disabled} compact />
    </Field>
  );
}

/** An item's tags in words, e.g. "Department: Farm · Policy number: FMG-1". */
export function ItemTagsText({ setups, value }: { setups: TagSetups; value: ItemTags }) {
  const text = [trackingText(setups.tracking, value.tracking), customValuesText(setups.custom, value.customFields)].filter(Boolean).join(" · ");
  return text ? <div className={ui.muted}>{text}</div> : null;
}
