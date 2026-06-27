import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (default true — gates dangerous actions). */
  destructive?: boolean;
  /**
   * If set, the operator must type this exact string before the confirm button
   * is enabled (e.g. an account number for an account deletion).
   */
  typeToConfirm?: string;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  typeToConfirm,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [typed, setTyped] = useState("");
  useFocusTrap(ref, true, onCancel);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const confirmDisabled = Boolean(typeToConfirm) && typed.trim() !== typeToConfirm;

  return (
    <div
      aria-labelledby="confirm-dialog-title"
      aria-modal="true"
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      role="dialog"
    >
      <div className="modal modal-confirm" ref={ref}>
        <header className="modal-head">
          <h2 id="confirm-dialog-title">{title}</h2>
        </header>
        <div className="modal-body">
          {description ? <p className="confirm-dialog-description">{description}</p> : null}
          {typeToConfirm ? (
            <label className="confirm-dialog-type-to-confirm">
              <span>
                Type <strong>{typeToConfirm}</strong> to confirm
              </span>
              <input
                aria-label="Type to confirm"
                autoComplete="off"
                className="input"
                onChange={(event) => setTyped(event.target.value)}
                type="text"
                value={typed}
              />
            </label>
          ) : null}
        </div>
        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button
            className={destructive ? "btn btn-destructive-subtle" : "btn btn-primary"}
            disabled={confirmDisabled}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

/**
 * Queues a confirmation before running a destructive action. Returns an async
 * `confirm(options)` that resolves true/false, plus a `dialog` node to render.
 *
 * Usage:
 *   const { confirm, dialog } = useConfirm();
 *   ...
 *   if (await confirm({ title: "Remove provider?", ... })) doDelete();
 *   ...
 *   return (<>{dialog}{rest}</>);
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      {...pending.options}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, dialog };
}
