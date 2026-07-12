import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useColorAccents } from "./ColorAccentsContext";

export type ToastVariant = "success" | "error" | "info" | "warn";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
  success: () => {},
  error: () => {},
  warn: () => {},
});

let toastSeq = 0;

/**
 * Lightweight, dependency-free toast system: a context provider plus a portal
 * that renders a fixed toast stack. Toasts auto-dismiss after `autoDismissMs`.
 */
export function ToastProvider({
  children,
  autoDismissMs = 4000,
}: {
  children: ReactNode;
  autoDismissMs?: number;
}) {
  const { colorAccents } = useColorAccents();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      toastSeq += 1;
      const id = toastSeq;
      setToasts((current) => [...current, { id, message, variant }]);
      if (autoDismissMs > 0 && typeof window !== "undefined") {
        window.setTimeout(() => dismiss(id), autoDismissMs);
      }
    },
    [autoDismissMs, dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (message: string) => toast(message, "success"),
      error: (message: string) => toast(message, "error"),
      warn: (message: string) => toast(message, "warn"),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <div
              aria-live="polite"
              className="toast-stack"
              data-color-accents={colorAccents ? "on" : "off"}
              role="status"
            >
              {toasts.map((item) => (
                <div className={`toast toast-${item.variant}`} key={item.id}>
                  <span className="toast-message">{item.message}</span>
                  <button
                    aria-label="Dismiss notification"
                    className="toast-close"
                    onClick={() => dismiss(item.id)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
