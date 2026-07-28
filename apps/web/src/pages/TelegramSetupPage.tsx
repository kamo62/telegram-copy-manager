import { Info, RefreshCw, ShieldCheck } from "lucide-react";
import { DialogPicker, type TelegramDialogSummary } from "../components/DialogPicker";
import { Panel } from "../components/Panel";
import { SetupFlow, type SetupFormState, type SetupStep } from "../components/SetupFlow";

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
            connected={isConnected}
            dialogs={dialogs}
            onRefresh={onRefreshDialogs}
            onRemove={onRemoveDialog}
            onSelect={onSelectDialog}
            selectedDialogIds={selectedDialogIds}
          />
        </>
      ) : null}
    </Panel>
  );
}
