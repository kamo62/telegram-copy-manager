import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["1"], description: "Performance tab" },
  { keys: ["2"], description: "Providers tab" },
  { keys: ["3"], description: "History tab" },
  { keys: ["4"], description: "Equity Guardian tab" },
  { keys: ["5"], description: "Symbol Settings tab" },
  { keys: ["6"], description: "Logs tab" },
  { keys: ["/"], description: "Open command palette" },
  { keys: ["⌘", "K"], description: "Open command palette (alt)" },
  { keys: ["R"], description: "Refresh dashboard" },
  { keys: ["?"], description: "Show this help" },
  { keys: ["Esc"], description: "Close dialogs and overlays" },
];

export function KeyboardShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, open, onClose);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      aria-labelledby="kb-shortcuts-title"
      aria-modal="true"
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="modal modal-shortcuts" ref={ref}>
        <header className="modal-head">
          <h2 id="kb-shortcuts-title">Keyboard shortcuts</h2>
          <button aria-label="Close" className="icon-btn" onClick={onClose} type="button">
            <X aria-hidden="true" size={14} />
          </button>
        </header>
        <div className="modal-body">
          <dl className="kb-shortcuts-list">
            {SHORTCUTS.map((shortcut) => (
              <div className="kb-shortcuts-row" key={shortcut.description}>
                <dt>
                  {shortcut.keys.map((key, index) => (
                    <span className="kb-key" key={`${shortcut.description}-${index}`}>
                      {key}
                    </span>
                  ))}
                </dt>
                <dd>{shortcut.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
