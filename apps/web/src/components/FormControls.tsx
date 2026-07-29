import { ChevronDown, ChevronUp } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, useRef, useState } from "react";

export function Switch({
  checked,
  defaultChecked,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [localChecked, setLocalChecked] = useState(Boolean(defaultChecked));
  const isChecked = checked ?? localChecked;
  return (
    <span className="switch">
      <input
        {...props}
        aria-checked={isChecked}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={(event) => {
          setLocalChecked(event.currentTarget.checked);
          onChange?.(event);
        }}
        role="switch"
        type="checkbox"
      />
      <span aria-hidden="true" className="switch-track">
        <span className="switch-knob" />
      </span>
    </span>
  );
}

export function NumberField({
  className = "",
  unit,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { unit?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const step = (direction: 1 | -1) => {
    const input = inputRef.current;
    if (!input) return;
    direction === 1 ? input.stepUp() : input.stepDown();
    const decimalPlaces = Math.max(
      String(props.step ?? 1).split(".")[1]?.length ?? 0,
      String(props.min ?? 0).split(".")[1]?.length ?? 0,
    );
    if (Number.isFinite(input.valueAsNumber)) {
      input.value = input.valueAsNumber.toFixed(decimalPlaces);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return (
    <span className={`number-field ${className}`}>
      <input {...props} ref={inputRef} type="number" />
      {unit ? <span className="number-field-unit">{unit}</span> : null}
      <span className="number-field-steppers">
        <button
          aria-label={`Increase ${props["aria-label"] ?? props.name ?? "value"}`}
          onClick={() => step(1)}
          tabIndex={-1}
          type="button"
        >
          <ChevronUp aria-hidden="true" size={11} />
        </button>
        <button
          aria-label={`Decrease ${props["aria-label"] ?? props.name ?? "value"}`}
          onClick={() => step(-1)}
          tabIndex={-1}
          type="button"
        >
          <ChevronDown aria-hidden="true" size={11} />
        </button>
      </span>
    </span>
  );
}

export function ThresholdBar({ danger, warn }: { danger: number; warn: number }) {
  const position = (value: number) => `${Math.min(100, Math.max(0, (value / 25) * 100))}%`;
  return (
    <div className="threshold-bar">
      <div className="threshold-tags">
        <span style={{ left: position(warn) }}>Warn {warn}%</span>
        <span style={{ left: position(danger) }}>Danger {danger}%</span>
      </div>
      <div
        aria-label={`Warn at ${warn}%, danger at ${danger}%`}
        className="threshold-track"
        role="img"
        style={{
          background: `linear-gradient(90deg, var(--ok) 0 ${position(warn)}, var(--warn) ${position(
            warn,
          )} ${position(danger)}, var(--danger) ${position(danger)} 100%)`,
        }}
      >
        <span className="threshold-pin warn" style={{ left: position(warn) }} />
        <span className="threshold-pin danger" style={{ left: position(danger) }} />
      </div>
      <div className="threshold-scale" aria-hidden="true">
        {[0, 5, 10, 15, 20, 25].map((value) => (
          <span key={value}>{value}%</span>
        ))}
      </div>
    </div>
  );
}

export function SaveBar({
  dirty,
  onDiscard,
  onSave,
  saving = false,
}: {
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
  saving?: boolean;
}) {
  return (
    <div aria-hidden={!dirty} className={`save-bar ${dirty ? "is-visible" : ""}`}>
      <div className="save-bar-inner">
        <span aria-hidden="true" className="save-bar-dot" />
        <strong>Unsaved execution changes</strong>
        <div className="save-bar-actions">
          <button className="btn btn-ghost btn-small" onClick={onDiscard} type="button">
            Discard
          </button>
          <button
            className="btn btn-primary btn-small"
            disabled={saving}
            onClick={onSave}
            type="button"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SegmentedControl({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <fieldset aria-label={ariaLabel} className="segmented-control">
      <legend className="visually-hidden">{ariaLabel}</legend>
      {children}
    </fieldset>
  );
}
