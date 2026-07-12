import { Check, Link2, MessageSquare, Radio } from "lucide-react";

interface OnboardingStep {
  icon: typeof Radio;
  title: string;
  description: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * First-run guidance shown when there are no providers and no MT5 accounts yet.
 * Replaces the empty dashboard with a concrete "what to do next" checklist.
 */
export function OnboardingCard({
  telegramConnected,
  hasProviders,
  hasAccounts,
  onConnectTelegram,
  onLinkAccount,
}: {
  telegramConnected: boolean;
  hasProviders: boolean;
  hasAccounts: boolean;
  onConnectTelegram: () => void;
  onLinkAccount: () => void;
}) {
  const steps: OnboardingStep[] = [
    {
      icon: Radio,
      title: "Connect Telegram",
      description: "Sign in with your Telegram account to read signal channels.",
      done: telegramConnected,
      actionLabel: "Connect Telegram",
      onAction: onConnectTelegram,
    },
    {
      icon: MessageSquare,
      title: "Pick a signal channel",
      description: "Choose the channels or groups to turn into providers.",
      done: hasProviders,
      actionLabel: telegramConnected ? "Choose channels" : undefined,
      onAction: telegramConnected ? onConnectTelegram : undefined,
    },
    {
      icon: Link2,
      title: "Link MT5",
      description: "Create a link slot and paste the code into your EA to start copying.",
      done: hasAccounts,
      actionLabel: "Link MT5 account",
      onAction: onLinkAccount,
    },
  ];

  return (
    <section aria-label="Getting started" className="onboarding-card">
      <header className="onboarding-head">
        <strong>Welcome — let's get you trading</strong>
        <p>Three quick steps connect Telegram signals to your MT5 account.</p>
      </header>
      <ol className="onboarding-steps">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li
              className={`onboarding-step${step.done ? " onboarding-step-done" : ""}`}
              key={step.title}
            >
              <span className="onboarding-step-num" aria-hidden="true">
                {step.done ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <div className="onboarding-step-body">
                <strong>
                  Step {index + 1}: {step.title}
                </strong>
                <p>{step.description}</p>
              </div>
              {!step.done && step.actionLabel && step.onAction ? (
                <button className="btn btn-primary btn-small" onClick={step.onAction} type="button">
                  {step.actionLabel}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
