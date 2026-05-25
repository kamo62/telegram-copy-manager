import { ArrowRight, CheckCircle2, Link2, LogOut, ShieldCheck } from "lucide-react";

export interface SetupFormState {
  apiId: string;
  apiHash: string;
  phone: string;
  code: string;
  password: string;
  sessionId: string;
  profileId: string;
}

export type SetupStep = "checking" | "credentials" | "code" | "password" | "connected";

export function SetupFlow({
  form,
  busy = false,
  error = "",
  onReset,
  setupStep,
  setForm,
  startTelegramConnection,
  submitCode,
  submitPassword,
}: {
  form: SetupFormState;
  busy?: boolean;
  error?: string;
  onReset?: () => Promise<void> | void;
  setupStep: SetupStep;
  setForm: React.Dispatch<React.SetStateAction<SetupFormState>>;
  startTelegramConnection: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitCode: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitPassword: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  if (setupStep === "checking") {
    return (
      <div className="connected-state" role="status">
        <span className="connected-state-glyph" aria-hidden="true">
          <ShieldCheck size={18} />
        </span>
        <div className="connected-state-body">
          <strong>Checking Telegram session</strong>
          <span>Loading the current server session.</span>
        </div>
      </div>
    );
  }

  if (setupStep === "connected") {
    return (
      <div className="connected-state" role="status">
        <span className="connected-state-glyph" aria-hidden="true">
          <CheckCircle2 size={18} />
        </span>
        <div className="connected-state-body">
          <strong>Telegram connected</strong>
          <span>Dialogs and provider messages can be reviewed below and in Parser Lab.</span>
        </div>
        {onReset ? (
          <button className="btn btn-ghost btn-destructive-subtle" onClick={onReset} type="button">
            <LogOut aria-hidden="true" size={13} />
            Log out Telegram
          </button>
        ) : null}
      </div>
    );
  }

  if (setupStep === "code") {
    return (
      <form className="setup-form" onSubmit={submitCode}>
        {error ? (
          <span className="setup-form-error" role="alert">
            {error}
          </span>
        ) : null}
        <label>
          Telegram code
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
            required
            value={form.code}
          />
        </label>
        <div className="setup-form-actions">
          <button className="btn btn-primary" disabled={busy} type="submit">
            Verify code
            <ArrowRight aria-hidden="true" size={13} />
          </button>
          {onReset ? (
            <button className="btn btn-ghost" onClick={onReset} type="button">
              Wrong number? Start over
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  if (setupStep === "password") {
    return (
      <form className="setup-form" onSubmit={submitPassword}>
        {error ? (
          <span className="setup-form-error" role="alert">
            {error}
          </span>
        ) : null}
        <label>
          2FA password
          <input
            autoComplete="current-password"
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
            required
            type="password"
            value={form.password}
          />
        </label>
        <div className="setup-form-actions">
          <button className="btn btn-primary" disabled={busy} type="submit">
            Finish setup
            <ShieldCheck aria-hidden="true" size={13} />
          </button>
          {onReset ? (
            <button className="btn btn-ghost" onClick={onReset} type="button">
              Use another phone number
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <form className="setup-form" onSubmit={startTelegramConnection}>
      {error ? (
        <span className="setup-form-error" role="alert">
          {error}
        </span>
      ) : null}
      <label>
        API ID
        <input
          autoComplete="off"
          onChange={(event) => setForm((current) => ({ ...current, apiId: event.target.value }))}
          required
          value={form.apiId}
        />
      </label>
      <label>
        API hash
        <input
          autoComplete="off"
          onChange={(event) => setForm((current) => ({ ...current, apiHash: event.target.value }))}
          required
          type="password"
          value={form.apiHash}
        />
      </label>
      <label>
        Phone number
        <input
          autoComplete="tel"
          onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
          required
          value={form.phone}
        />
      </label>
      <div className="setup-form-actions">
        <button className="btn btn-primary" disabled={busy} type="submit">
          Send Telegram code
          <Link2 aria-hidden="true" size={13} />
        </button>
      </div>
    </form>
  );
}
