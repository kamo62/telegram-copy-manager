import { Sliders, Sparkles, Timer, TrendingUp } from "lucide-react";
import type { DashboardSnapshot } from "../App";
import { Panel } from "../components/Panel";

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
  monoInput?: boolean;
}

function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="settings-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="settings-field-hint">{hint}</span> : null}
    </div>
  );
}

function SettingsSection({
  title,
  icon,
  description,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div className="settings-section-icon" aria-hidden="true">
          {icon}
        </div>
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

export function SettingsPage({
  settings,
  onSubmit,
  onSaveForm,
}: {
  settings: DashboardSnapshot["appSettings"];
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSaveForm: (form: HTMLFormElement) => void;
}) {
  return (
    <Panel className="wide-panel" title="Settings">
      <p className="panel-intro">
        Defaults applied when a parsed signal is missing fields, plus integration secrets and
        polling cadence. Per-provider overrides live in each Provider's configuration modal.
      </p>
      <form className="settings-form-layout" onSubmit={onSubmit}>
        <SettingsSection
          description="Used when an approved signal does not specify lot size, risk, SL, or TP."
          icon={<Sliders aria-hidden="true" size={18} />}
          title="Execution defaults"
        >
          <div className="settings-grid">
            <Field
              hint="Per-trade volume in lots when no provider channel lot size is configured."
              htmlFor="defaultLotSize"
              label="Default lot size"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.defaultLotSize}
                id="defaultLotSize"
                min="0.01"
                name="defaultLotSize"
                step="0.01"
                type="number"
              />
            </Field>
            <Field
              hint="Risk percent of balance for the percent-mode sizing."
              htmlFor="defaultRiskPercent"
              label="Default risk percent"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.defaultRiskPercent}
                id="defaultRiskPercent"
                min="0.01"
                name="defaultRiskPercent"
                step="0.01"
                type="number"
              />
            </Field>
            <Field
              hint="Stop-loss distance in pips when the signal omits SL."
              htmlFor="defaultStopLossPips"
              label="Default SL pips"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.defaultStopLossPips}
                id="defaultStopLossPips"
                min="1"
                name="defaultStopLossPips"
                step="1"
                type="number"
              />
            </Field>
            <Field
              hint="Take-profit distance in pips when the signal omits TP."
              htmlFor="defaultTakeProfitPips"
              label="Default TP pips"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.defaultTakeProfitPips}
                id="defaultTakeProfitPips"
                min="1"
                name="defaultTakeProfitPips"
                step="1"
                type="number"
              />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection
          description="Order types the EA is allowed to place. Disabled types fall through to operator review."
          icon={<TrendingUp aria-hidden="true" size={18} />}
          title="Allowed order types"
        >
          <div className="settings-checkbox-row">
            {(["MARKET", "LIMIT", "STOP"] as const).map((type) => (
              <label className="settings-checkbox" key={type}>
                <input
                  defaultChecked={settings.allowedOrderTypes.includes(type)}
                  name="allowedOrderTypes"
                  type="checkbox"
                  value={type}
                />
                <span>Allow {type.toLowerCase()} orders</span>
              </label>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          description="How often the dashboard polls for fresh provider, queue, and broker state."
          icon={<Timer aria-hidden="true" size={18} />}
          title="Polling"
        >
          <div className="settings-grid">
            <Field
              hint="Minimum 1 second. Higher values reduce backend load but slow up live state."
              htmlFor="pollingIntervalSeconds"
              label="Polling interval (seconds)"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.pollingIntervalSeconds}
                id="pollingIntervalSeconds"
                min="1"
                name="pollingIntervalSeconds"
                step="1"
                type="number"
              />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection
          description="Optional GPT extraction for parser signals that need additional normalization. The key is stored on the server."
          icon={<Sparkles aria-hidden="true" size={18} />}
          title="AI extraction"
        >
          <Field
            hint={
              settings.azureOpenAIKeyConfigured
                ? "A key is currently configured. Paste a new value to replace it."
                : "Leave blank to keep AI extraction disabled."
            }
            htmlFor="azureOpenAIApiKey"
            label="Azure OpenAI API key"
          >
            <input
              className="settings-input"
              id="azureOpenAIApiKey"
              name="azureOpenAIApiKey"
              placeholder={settings.azureOpenAIKeyConfigured ? "Configured" : "Paste API key"}
              type="password"
            />
          </Field>
        </SettingsSection>

        <div className="settings-actions">
          <button
            className="btn btn-primary"
            onClick={(event) => {
              if (event.currentTarget.form) onSaveForm(event.currentTarget.form);
            }}
            type="button"
          >
            Save execution settings
          </button>
        </div>
      </form>
    </Panel>
  );
}
