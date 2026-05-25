import { Info, RefreshCw, ShieldCheck } from "lucide-react";
import { DialogPicker, type TelegramDialogSummary } from "../components/DialogPicker";
import { Panel } from "../components/Panel";
import { SetupFlow, type SetupFormState, type SetupStep } from "../components/SetupFlow";
import { Tag } from "../components/Tag";

export function TelegramSetupPage({
  form,
  busy,
  error,
  setupStep,
  setForm,
  startTelegramConnection,
  submitCode,
  submitPassword,
  onReset,
  dialogs,
  onRefreshDialogs,
  onResyncProviders,
  onSelectDialog,
  onRemoveDialog,
  selectedDialogIds,
  providers = [],
  onToggleProvider,
  onRemoveProvider,
  onConfigureProvider,
}: {
  form: SetupFormState;
  busy: boolean;
  error: string;
  setupStep: SetupStep;
  setForm: React.Dispatch<React.SetStateAction<SetupFormState>>;
  startTelegramConnection: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitCode: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitPassword: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onReset: () => Promise<void>;
  dialogs: TelegramDialogSummary[];
  onRefreshDialogs: () => Promise<void>;
  onResyncProviders?: () => Promise<void>;
  onSelectDialog: (dialog: TelegramDialogSummary) => Promise<void>;
  onRemoveDialog?: (dialog: TelegramDialogSummary) => Promise<void> | void;
  selectedDialogIds: string[];
  // Global provider lifecycle lives here (the Providers tab is account-scoped and read-only
  // in overview), so enabling/pausing/removing a provider happens alongside dialog selection.
  providers?: Array<{ id: string; title: string; enabled: boolean }>;
  onToggleProvider?: (provider: { id: string; title: string; enabled: boolean }) => void;
  onRemoveProvider?: (provider: { id: string; title: string; enabled: boolean }) => void;
  onConfigureProvider?: (provider: { id: string; title: string; enabled: boolean }) => void;
}) {
  const isConnected = setupStep === "connected";
  return (
    <Panel className="setup-panel wide-panel" title="Telegram Setup">
      <div className="setup-help">
        <ShieldCheck aria-hidden="true" size={16} />
        <div>
          <strong>How this works</strong>
          <p>
            Sign in to Telegram with the phone number that already has access to your signal
            channels. Credentials live on the server, never the browser. Once connected, pick the
            channels or groups you want as providers — each becomes a row in the Providers tab.
          </p>
        </div>
      </div>

      <SetupFlow
        form={form}
        busy={busy}
        error={error}
        onReset={onReset}
        setForm={setForm}
        setupStep={setupStep}
        startTelegramConnection={startTelegramConnection}
        submitCode={submitCode}
        submitPassword={submitPassword}
      />

      {isConnected ? (
        <>
          <div className="setup-next">
            <Info aria-hidden="true" size={14} />
            <span className="setup-next-message">
              {selectedDialogIds.length === 0
                ? "Pick at least one channel below to start collecting signals."
                : `${selectedDialogIds.length} provider${selectedDialogIds.length === 1 ? "" : "s"} selected. Open the Providers tab to assign them to MT5 accounts.`}
            </span>
            {onResyncProviders ? (
              <button
                className="btn btn-ghost btn-small"
                disabled={busy}
                onClick={() => void onResyncProviders()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={12} />
                Resync providers
              </button>
            ) : null}
          </div>
          <DialogPicker
            dialogs={dialogs}
            onRefresh={onRefreshDialogs}
            onRemove={onRemoveDialog}
            onSelect={onSelectDialog}
            selectedDialogIds={selectedDialogIds}
          />

          {providers.length > 0 ? (
            <section className="setup-providers">
              <h3 className="config-section-title">Provider monitoring</h3>
              <p className="panel-intro">
                Enable or pause signal collection, set the provider's default lot/risk/TP, or remove
                it. Per-account copy and config overrides live in the Providers tab.
              </p>
              <ul className="setup-provider-list">
                {providers.map((provider) => (
                  <li className="setup-provider-row" key={provider.id}>
                    <span className="setup-provider-name">{provider.title}</span>
                    <Tag tone={provider.enabled ? "good" : "muted"}>
                      {provider.enabled ? "Auto-copy enabled" : "Provider paused"}
                    </Tag>
                    <span className="setup-provider-actions">
                      <button
                        aria-label={`Configure ${provider.title}`}
                        className="btn btn-ghost btn-small"
                        onClick={() => onConfigureProvider?.(provider)}
                        type="button"
                      >
                        Configure
                      </button>
                      <button
                        aria-label={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
                        className="btn btn-ghost btn-small"
                        onClick={() => onToggleProvider?.(provider)}
                        type="button"
                      >
                        {provider.enabled ? "Pause" : "Enable"}
                      </button>
                      <button
                        aria-label={`Remove provider ${provider.title}`}
                        className="btn btn-ghost btn-small btn-destructive-subtle"
                        onClick={() => onRemoveProvider?.(provider)}
                        type="button"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
