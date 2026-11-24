"use client";

import { Button, ui } from "@/components/ui";
import type { SearchFormula } from "@/lib/saved-searches/formulas";
import type { PublicRecordType as RecordType } from "@/lib/saved-searches/org-catalogue";
import styles from "./saved-searches.module.css";

/** Calculated columns: a name and a sum over the record's number fields, e.g. {total} - {owing}. */
export function Formulas({
  type,
  formulas,
  onChange,
}: {
  type: RecordType;
  formulas: SearchFormula[];
  onChange: (formulas: SearchFormula[]) => void;
}) {
  const numbers = type.fields.filter(
    (field) => field.type === "money" || field.type === "number",
  );
  if (numbers.length === 0) return null;
  const set = (index: number, next: Partial<SearchFormula>) =>
    onChange(
      formulas.map((formula, at) =>
        at === index ? { ...formula, ...next } : formula,
      ),
    );
  const free = ["f1", "f2", "f3", "f4", "f5"].find(
    (key) => !formulas.some((formula) => formula.key === key),
  );
  return (
    <div className={styles.filters}>
      {formulas.map((formula, index) => (
        <div key={formula.key} className={styles.formula}>
          <div className={styles.filter}>
            <input
              aria-label="Name of the calculated column"
              placeholder="Paid so far"
              maxLength={40}
              value={formula.label}
              onChange={(event) => set(index, { label: event.target.value })}
            />
            <span className={ui.muted}>=</span>
            <input
              aria-label="Sum"
              className={styles.sum}
              placeholder="{total} - {owing}"
              maxLength={200}
              value={formula.expression}
              onChange={(event) =>
                set(index, { expression: event.target.value })
              }
            />
            <Button
              size="small"
              variant="secondary"
              onClick={() => onChange(formulas.filter((_, at) => at !== index))}
            >
              Remove
            </Button>
          </div>
          <div className={styles.starts}>
            <span className={ui.muted}>Add to the sum:</span>
            {numbers.map((field) => (
              <Button
                key={field.key}
                size="small"
                variant="secondary"
                onClick={() =>
                  set(index, {
                    expression: `${formula.expression}${formula.expression && !formula.expression.endsWith(" ") ? " " : ""}{${field.key}}`,
                  })
                }
              >
                {field.label}
              </Button>
            ))}
            <span className={ui.muted}>then + - * / and brackets.</span>
          </div>
        </div>
      ))}
      {free ? (
        <div>
          <Button
            size="small"
            variant="secondary"
            onClick={() =>
              onChange([...formulas, { key: free, label: "", expression: "" }])
            }
          >
            Add a calculated column
          </Button>
        </div>
      ) : null}
    </div>
  );
}
