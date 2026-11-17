"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "./ui.module.css";

export type ConfirmOptions = {
  /** Label for the OK button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label for the Cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Use the danger style for the OK button (Void, Delete, ...). */
  danger?: boolean;
  /** Optional heading above the message. */
  title?: string;
};

export type ConfirmFunction = (message: string, options?: ConfirmOptions) => Promise<boolean>;

/** Three ways out: e.g. Save and leave, Discard and leave, Keep editing. */
export type ChooseOptions = ConfirmOptions & { otherLabel: string };
export type Choice = "confirm" | "other" | "cancel";
export type ChooseFunction = (message: string, options: ChooseOptions) => Promise<Choice>;

type Pending = {
  message: string;
  options: ConfirmOptions & { otherLabel?: string };
  resolve: (result: Choice) => void;
};

const ConfirmContext = createContext<{ confirm: ConfirmFunction; choose: ChooseFunction } | null>(null);

/**
 * Replaces window.confirm with an in-page dialog. Place once near the root;
 * call useConfirm() in any client component below it.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const choose = useCallback<ChooseFunction>((message, options) => {
    return new Promise<Choice>((resolve) => {
      // A second call while one is open cancels the first.
      pendingRef.current?.resolve("cancel");
      const next = { message, options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const confirm = useCallback<ConfirmFunction>(
    (message, options = {}) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve("cancel");
        const next: Pending = { message, options, resolve: (result) => resolve(result === "confirm") };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );
  const value = useMemo(() => ({ confirm, choose }), [confirm, choose]);

  const settle = useCallback((result: Choice) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(result);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) dialog.showModal();
  }, [pending]);

  // Never leave a caller hanging if the provider goes away.
  useEffect(() => () => pendingRef.current?.resolve("cancel"), []);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <dialog
          ref={dialogRef}
          className={styles.confirmDialog}
          aria-labelledby={pending.options.title ? "confirm-dialog-title" : undefined}
          aria-describedby="confirm-dialog-message"
          onCancel={(event) => {
            event.preventDefault();
            settle("cancel");
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) settle("cancel");
          }}
        >
          <div className={styles.confirmBody}>
            {pending.options.title ? (
              <h2 id="confirm-dialog-title" className={styles.confirmTitle}>
                {pending.options.title}
              </h2>
            ) : null}
            <p id="confirm-dialog-message" className={styles.confirmMessage}>
              {pending.message}
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                autoFocus
                onClick={() => settle("cancel")}
              >
                {pending.options.cancelLabel ?? "Cancel"}
              </button>
              {pending.options.otherLabel ? (
                <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => settle("other")}>
                  {pending.options.otherLabel}
                </button>
              ) : null}
              <button
                type="button"
                className={`${styles.button} ${pending.options.danger ? styles.danger : styles.primary}`}
                onClick={() => settle("confirm")}
              >
                {pending.options.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

/** Returns confirm(message, options?) => Promise<boolean>. */
export function useConfirm(): ConfirmFunction {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useConfirm must be used inside <ConfirmProvider>.");
  return context.confirm;
}

/** Returns choose(message, options) => Promise<"confirm" | "other" | "cancel">, for a question with three answers. */
export function useChoose(): ChooseFunction {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useChoose must be used inside <ConfirmProvider>.");
  return context.choose;
}
