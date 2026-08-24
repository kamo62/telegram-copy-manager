import { RefreshCw, Send } from "lucide-react";
import type { SetupFormState, SetupStep } from "./SetupFlow";

export function SignIn({
  form,
  busy = false,
  error = "",
  onReset,
  onRetry,
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
  onRetry?: () => void;
  setupStep: SetupStep;
  setForm: React.Dispatch<React.SetStateAction<SetupFormState>>;
  startTelegramConnection: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitCode: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitPassword: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const stepCopy: Record<typeof setupStep, { title: string; subtitle: string }> = {
    checking: {
      title: "Checking Telegram session",
      subtitle: "Loading the saved server session before showing the dashboard.",
    },
    credentials: {
      title: "Sign in to Telegram",
      subtitle: "Please confirm your country code\nand enter your phone number.",
    },
    code: {
      title: "Enter the verification code",
      subtitle: "We just sent a code to your Telegram app. Enter it below to continue.",
    },
    password: {
      title: "Two-factor password",
      subtitle: "Your account has two-factor enabled. Enter your password to finish signing in.",
    },
    connected: { title: "Connected", subtitle: "" },
    unavailable: {
      title: "Cannot reach the server",
      subtitle: "Telegram status could not be loaded. We have not treated this as a logout.",
    },
  };

  const copy = stepCopy[setupStep];
  const phoneValid = form.phone.trim().length > 0;

  return (
    <div className="signin-shell">
      <header className="signin-titlebar">
        <div className="signin-titlebar-brand">
          <Send size={14} aria-hidden="true" />
          <span>Telegram TC · Signals Copier</span>
        </div>
      </header>

      <main className="signin-main" aria-labelledby="signin-heading">
        <div className="signin-logo" aria-hidden="true">
          <Send size={42} strokeWidth={1.5} />
        </div>

        <h1 className="signin-title" id="signin-heading">
          {copy.title}
        </h1>
        <p className="signin-subtitle">{copy.subtitle}</p>
        {error ? (
          <p className="signin-meta" role="alert">
            {error}
          </p>
        ) : null}

        {setupStep === "checking" ? (
          <div className="signin-loading" role="status">
            <span className="signin-loading-dot" aria-hidden="true" />
            <span>Checking server session</span>
          </div>
        ) : null}

        {setupStep === "unavailable" ? (
          <div className="signin-loading">
            <button className="signin-cta" onClick={onRetry} type="button">
              <RefreshCw aria-hidden="true" size={14} />
              Retry
            </button>
          </div>
        ) : null}

        {setupStep === "credentials" ? (
          <form className="signin-form" onSubmit={startTelegramConnection}>
            <FloatingField
              autoComplete="tel"
              inputMode="tel"
              label="Phone number"
              name="phone"
              onChange={(value) => setForm((current) => ({ ...current, phone: value }))}
              placeholder="+27 729 887 365"
              required
              value={form.phone}
            />
            <button className="signin-cta" disabled={!phoneValid || busy} type="submit">
              {busy ? "Sending..." : "Next"}
            </button>
            <p className="signin-meta">
              Telegram API credentials are loaded from the server's <code>.env</code>; only your
              phone number is required here.
            </p>
          </form>
        ) : null}

        {setupStep === "code" ? (
          <form className="signin-form" onSubmit={submitCode}>
            <FloatingField
              autoComplete="one-time-code"
              inputMode="numeric"
              label="Verification code"
              name="code"
              onChange={(value) => setForm((current) => ({ ...current, code: value }))}
              required
              value={form.code}
            />
            <button className="signin-cta" disabled={!form.code.trim() || busy} type="submit">
              Verify code
            </button>
            {onReset ? (
              <button className="btn-ghost" onClick={onReset} type="button">
                Wrong phone number? Start over
              </button>
            ) : null}
          </form>
        ) : null}

        {setupStep === "password" ? (
          <form className="signin-form" onSubmit={submitPassword}>
            <FloatingField
              autoComplete="current-password"
              label="Two-factor password"
              name="password"
              onChange={(value) => setForm((current) => ({ ...current, password: value }))}
              required
              type="password"
              value={form.password}
            />
            <button className="signin-cta" disabled={!form.password.trim() || busy} type="submit">
              Finish setup
            </button>
            {onReset ? (
              <button className="btn-ghost" onClick={onReset} type="button">
                Use another phone number
              </button>
            ) : null}
          </form>
        ) : null}
      </main>

      <footer className="signin-footer">
        <span>Telegram TC</span>
      </footer>
    </div>
  );
}

function FloatingField({
  autoComplete,
  inputMode,
  label,
  name,
  onChange,
  placeholder,
  required,
  type = "text",
  value,
}: {
  autoComplete?: string;
  inputMode?: "tel" | "numeric" | "text";
  label: string;
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  value: string;
}) {
  const hasValue = value.length > 0;
  return (
    <label className={`floating-field ${hasValue ? "has-value" : ""}`}>
      <span className="floating-field-label">{label}</span>
      <input
        autoComplete={autoComplete}
        inputMode={inputMode}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
    </label>
  );
}
