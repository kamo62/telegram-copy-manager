import {
  Bell,
  DatabaseBackup,
  DollarSign,
  Moon,
  ShieldAlert,
  Sliders,
  Sparkles,
  Sun,
  Timer,
  TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "../App";
import { Panel } from "../components/Panel";
import { useColorAccents } from "../contexts/ColorAccentsContext";
import { useTheme } from "../contexts/ThemeContext";

interface AccountThresholdsRow {
  id: string;
  accountNumber: string;
  currency: string;
  drawdownWarnPctOverride: number | null;
  drawdownDangerPctOverride: number | null;
}

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
  accounts = [],
  onAccountRiskThresholdsSave,
  onAlertTest,
  onBackup,
}: {
  settings: DashboardSnapshot["appSettings"];
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSaveForm: (form: HTMLFormElement) => void;
  accounts?: AccountThresholdsRow[];
  onAccountRiskThresholdsSave?: (
    accountId: string,
    warnPct: number | null,
    dangerPct: number | null,
  ) => void;
  onAlertTest?: () => Promise<void> | void;
  onBackup?: () => Promise<string>;
}) {
  const { colorAccents, setColorAccents } = useColorAccents();
  const { theme, setTheme } = useTheme();
  const [testSending, setTestSending] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupFilename, setBackupFilename] = useState("");
  return (
    <Panel className="wide-panel settings-panel" title="Settings">
      <p className="panel-intro">
        Defaults applied when a parsed signal is missing fields, plus integration secrets and
        polling cadence. Per-provider overrides live in each Provider's configuration modal.
      </p>
      <form className="settings-form-layout" onSubmit={onSubmit}>
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
        <SettingsSection
          description="Show restrained colour only for charts and operational status. This preference stays in this browser."
          icon={<Sparkles aria-hidden="true" size={18} />}
          title="Display"
        >
          <fieldset className="settings-theme-picker">
            <legend className="visually-hidden">Colour theme</legend>
            <button
              aria-pressed={theme === "light"}
              className={theme === "light" ? "active" : ""}
              onClick={() => setTheme("light")}
              type="button"
            >
              <Sun aria-hidden="true" size={14} />
              Light
            </button>
            <button
              aria-pressed={theme === "dark"}
              className={theme === "dark" ? "active" : ""}
              onClick={() => setTheme("dark")}
              type="button"
            >
              <Moon aria-hidden="true" size={14} />
              Dark
            </button>
          </fieldset>
          <label className="settings-checkbox">
            <input
              aria-label="Colour accents"
              checked={colorAccents}
              onChange={(event) => setColorAccents(event.target.checked)}
              type="checkbox"
            />
            <span>Colour accents</span>
          </label>
        </SettingsSection>
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
          description="When a drawdown crosses these percentages the dashboard tints the value amber (warn) or red (danger). Per-account overrides live alongside each connected account."
          icon={<ShieldAlert aria-hidden="true" size={18} />}
          title="Risk display thresholds"
        >
          <div className="settings-grid">
            <Field
              hint="Amber tone applied to drawdown values at or above this percent of peak equity."
              htmlFor="drawdownWarnPct"
              label="Warn at (%)"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.drawdownWarnPct}
                id="drawdownWarnPct"
                max="100"
                min="0"
                name="drawdownWarnPct"
                step="0.5"
                type="number"
              />
            </Field>
            <Field
              hint="Red tone applied to drawdown values at or above this percent. Should be higher than the warn threshold."
              htmlFor="drawdownDangerPct"
              label="Danger at (%)"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.drawdownDangerPct}
                id="drawdownDangerPct"
                max="100"
                min="0"
                name="drawdownDangerPct"
                step="0.5"
                type="number"
              />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection
          description="Used for overview money summaries when linked MT5 accounts report different currencies."
          icon={<DollarSign aria-hidden="true" size={18} />}
          title="Reporting currency"
        >
          <div className="settings-grid">
            <Field
              hint="Mixed-currency account summaries are normalized into this currency."
              htmlFor="reportingCurrency"
              label="Reporting currency"
            >
              <select
                className="settings-input mono"
                defaultValue={settings.reportingCurrency}
                id="reportingCurrency"
                name="reportingCurrency"
              >
                <option value="USD">USD</option>
                <option value="ZAR">ZAR</option>
              </select>
            </Field>
            <Field
              hint="Conversion base for ZAR and USD account summaries."
              htmlFor="usdZarRate"
              label="USD/ZAR rate"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.usdZarRate}
                id="usdZarRate"
                min="0.01"
                name="usdZarRate"
                step="0.01"
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
          description="How often the dashboard polls for fresh provider, queue, and broker state, and how long an approved signal blocks an identical retry."
          icon={<Timer aria-hidden="true" size={18} />}
          title="Polling & dedup"
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
            <Field
              hint="How long an approved signal blocks an identical retry. Lower this when trading news, where the same provider re-issues quickly. Range 60–3600."
              htmlFor="dedupWindowSeconds"
              label="Signal dedup window (seconds)"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.dedupWindowSeconds}
                id="dedupWindowSeconds"
                max="3600"
                min="60"
                name="dedupWindowSeconds"
                step="30"
                type="number"
              />
            </Field>
            <Field
              hint="Open trades older than this are marked expired instead of being sent to MT5 after a reconnect. Use 0 to disable. Range 60–86400."
              htmlFor="maxOpenTradeAgeSeconds"
              label="Open trade expiry (seconds)"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.maxOpenTradeAgeSeconds}
                id="maxOpenTradeAgeSeconds"
                max="86400"
                min="0"
                name="maxOpenTradeAgeSeconds"
                step="60"
                type="number"
              />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection
          description="Send operational alerts through a Telegram bot. Each alert type can be enabled independently."
          icon={<Bell aria-hidden="true" size={18} />}
          title="Alerting"
        >
          <div className="settings-grid">
            <Field
              hint={
                settings.alertBotConfigured
                  ? "A bot token is configured. Enter a replacement token only to change it."
                  : "Token issued by BotFather. Leave blank until alerting is configured."
              }
              htmlFor="alertBotToken"
              label="Bot token"
            >
              <input
                className="settings-input mono"
                id="alertBotToken"
                name="alertBotToken"
                placeholder="123456:ABC..."
                type="password"
              />
            </Field>
            <Field
              hint="Telegram chat or channel ID that receives operational alerts."
              htmlFor="alertChatId"
              label="Chat ID"
            >
              <input
                className="settings-input mono"
                defaultValue={settings.alertChatId ?? ""}
                id="alertChatId"
                name="alertChatId"
                placeholder="-100..."
                type="text"
              />
            </Field>
          </div>
          <div className="settings-checkbox-row settings-alert-toggles">
            {(
              [
                ["alertOnGuardianPause", "Equity Guardian pauses"],
                ["alertOnEaOffline", "EA offline"],
                ["alertOnExecFailed", "Execution failures"],
                ["alertOnHeld", "Held signals"],
                ["alertOnTelegramStall", "Telegram ingestion stalls"],
              ] as const
            ).map(([name, label]) => (
              <label className="settings-checkbox" key={name}>
                <input defaultChecked={settings[name] ?? false} name={name} type="checkbox" />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {onAlertTest ? (
            <div className="settings-inline-actions">
              <button
                className="btn btn-ghost btn-small"
                disabled={testSending}
                onClick={async () => {
                  setTestSending(true);
                  try {
                    await onAlertTest();
                  } finally {
                    setTestSending(false);
                  }
                }}
                type="button"
              >
                {testSending ? "Sending..." : "Send test message"}
              </button>
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          description="Create an immediate SQLite backup on the server. The server retains the newest backup files."
          icon={<DatabaseBackup aria-hidden="true" size={18} />}
          title="Database backup"
        >
          <div className="settings-inline-actions">
            <button
              className="btn btn-ghost btn-small"
              disabled={backupRunning}
              onClick={async () => {
                if (!onBackup) return;
                setBackupRunning(true);
                try {
                  setBackupFilename(await onBackup());
                } finally {
                  setBackupRunning(false);
                }
              }}
              type="button"
            >
              {backupRunning ? "Backing up..." : "Back up database now"}
            </button>
            {backupFilename ? (
              <span className="settings-backup-filename">
                Created <code>{backupFilename}</code>
              </span>
            ) : null}
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
      </form>

      {accounts.length > 0 && onAccountRiskThresholdsSave ? (
        <AccountRiskThresholdsSection accounts={accounts} onSave={onAccountRiskThresholdsSave} />
      ) : null}
    </Panel>
  );
}

function AccountRiskThresholdsSection({
  accounts,
  onSave,
}: {
  accounts: AccountThresholdsRow[];
  onSave: (accountId: string, warnPct: number | null, dangerPct: number | null) => void;
}) {
  return (
    <SettingsSection
      description="Per-account warn / danger overrides. Leave a field blank to fall back to the global percentages above."
      icon={<ShieldAlert aria-hidden="true" size={18} />}
      title="Per-account risk overrides"
    >
      <div className="data-table-wrap account-thresholds-wrap">
        <table className="data-table account-thresholds-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th className="num" scope="col">
                Warn (%)
              </th>
              <th className="num" scope="col">
                Danger (%)
              </th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <AccountThresholdRow account={account} key={account.id} onSave={onSave} />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}

function AccountThresholdRow({
  account,
  onSave,
}: {
  account: AccountThresholdsRow;
  onSave: (accountId: string, warnPct: number | null, dangerPct: number | null) => void;
}) {
  const initialWarn =
    account.drawdownWarnPctOverride === null ? "" : String(account.drawdownWarnPctOverride);
  const initialDanger =
    account.drawdownDangerPctOverride === null ? "" : String(account.drawdownDangerPctOverride);
  const [warn, setWarn] = useState(initialWarn);
  const [danger, setDanger] = useState(initialDanger);
  useEffect(() => {
    setWarn(initialWarn);
    setDanger(initialDanger);
  }, [initialWarn, initialDanger]);
  const dirty = warn !== initialWarn || danger !== initialDanger;
  return (
    <tr>
      <th className="data-table-row-head" scope="row">
        <strong>{account.accountNumber}</strong>
        <span className="data-table-subtle">{account.currency}</span>
      </th>
      <td className="num-cell">
        <input
          aria-label={`Warn % override for ${account.accountNumber}`}
          className="settings-input mono"
          max="100"
          min="0"
          onChange={(event) => setWarn(event.target.value)}
          placeholder="—"
          step="0.5"
          type="number"
          value={warn}
        />
      </td>
      <td className="num-cell">
        <input
          aria-label={`Danger % override for ${account.accountNumber}`}
          className="settings-input mono"
          max="100"
          min="0"
          onChange={(event) => setDanger(event.target.value)}
          placeholder="—"
          step="0.5"
          type="number"
          value={danger}
        />
      </td>
      <td className="data-table-actions">
        <button
          className="btn btn-ghost btn-small"
          disabled={!dirty}
          onClick={() =>
            onSave(
              account.id,
              warn === "" ? null : Number(warn),
              danger === "" ? null : Number(danger),
            )
          }
          type="button"
        >
          Save
        </button>
        {(warn !== "" || danger !== "") && (
          <button
            className="btn btn-ghost btn-small"
            onClick={() => {
              setWarn("");
              setDanger("");
              onSave(account.id, null, null);
            }}
            type="button"
          >
            Use global
          </button>
        )}
      </td>
    </tr>
  );
}
