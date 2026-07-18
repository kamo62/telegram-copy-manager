import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette({
  commands,
  onClose,
  open,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter((command) =>
    command.label.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedCommand = filtered[selectedIndex];

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        if (filtered.length === 0) return;
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (event.key === "ArrowUp") {
        if (filtered.length === 0) return;
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[selectedIndex];
        if (command) {
          command.action();
          onClose();
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, selectedIndex, onClose]);

  if (!open) return null;

  return (
    <div
      className="command-palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="command-palette">
        <div className="command-palette-input">
          <Search size={14} aria-hidden="true" />
          <input
            aria-activedescendant={
              selectedCommand ? `command-palette-option-${selectedCommand.id}` : undefined
            }
            aria-label="Command palette search"
            aria-controls="command-palette-list"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command..."
            ref={inputRef}
            type="text"
            value={query}
          />
          <span className="kbd-hint">
            <CornerDownLeft size={10} aria-hidden="true" />
          </span>
        </div>
        <div className="command-list" id="command-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="command-empty">No commands match "{query}"</div>
          ) : (
            filtered.map((command, index) => (
              <button
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? "active" : ""}
                id={`command-palette-option-${command.id}`}
                key={command.id}
                onClick={() => {
                  command.action();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                role="option"
                type="button"
              >
                <span className="command-label">{command.label}</span>
                {command.shortcut ? (
                  <span className="command-shortcut">{command.shortcut}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
