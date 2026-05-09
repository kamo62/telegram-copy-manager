import { ArrowRight, CheckCircle2, Link2, ShieldCheck } from "lucide-react";

export interface SetupFormState {
  apiId: string;
  apiHash: string;
  phone: string;
  code: string;
  password: string;
  sessionId: string;
  profileId: string;
}

export function SetupFlow({
  form,
  setupStep,
  setForm,
  startTelegramConnection,
  submitCode,
  submitPassword,
}: {
  form: SetupFormState;
  setupStep: "credentials" | "code" | "password" | "connected";
  setForm: React.Dispatch<React.SetStateAction<SetupFormState>>;
  startTelegramConnection: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitCode: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitPassword: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  if (setupStep === "connected") {
    return (
      <div className="connected-state">
        <CheckCircle2 size={20} aria-hidden="true" />
        <div>
          <strong>Telegram connected</strong>
          <span>Dialogs and provider messages can be reviewed in Parser Lab.</span>
        </div>
      </div>
    );
  }

  if (setupStep === "code") {
    return (
      <form className="setup-form" onSubmit={submitCode}>
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
        <button type="submit">
          Verify code
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </form>
    );
  }

  if (setupStep === "password") {
    return (
      <form className="setup-form" onSubmit={submitPassword}>
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
        <button type="submit">
          Finish setup
          <ShieldCheck size={14} aria-hidden="true" />
        </button>
      </form>
    );
  }

  return (
    <form className="setup-form" onSubmit={startTelegramConnection}>
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
      <button type="submit">
        Send Telegram code
        <Link2 size={14} aria-hidden="true" />
      </button>
    </form>
  );
}
