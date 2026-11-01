import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { NumberField, Switch } from "../components/FormControls";
import { Panel } from "../components/Panel";
import { useLocale } from "../contexts/LocaleContext";
import { formatPercent } from "../lib/format";

interface Guardian {
  accountId: string;
  accountNumber: string;
  threshold: number;
  currentDrawdown: number;
  paused: boolean;
  enabled: boolean;
}

function severity(currentDrawdown: number, threshold: number): "ok" | "warn" | "breach" {
  if (threshold <= 0) return "ok";
  const ratio = currentDrawdown / threshold;
  if (ratio >= 1) return "breach";
  if (ratio >= 0.75) return "warn";
  return "ok";
}

export function EquityGuardianPage({
  guardians,
  onSave,
  onUnpause,
  guardianHeldCounts = {},
}: {
  guardians: Guardian[];
  onSave: (accountId: string, form: HTMLFormElement) => void;
  onUnpause: (accountId: string, requeueHeld: boolean) => void;
  guardianHeldCounts?: Record<string, number>;
}) {
  const { locale } = useLocale();
  const [unpauseChoice, setUnpauseChoice] = useState<Guardian | null>(null);
  return (
    <Panel className="wide-panel" hideTitle title="Equity Guardian">
      <p className="panel-intro">
        When the current drawdown reaches the threshold, the queue rejects new OPEN_TRADE commands
        for that account. Lifecycle commands (close, modify, BE) on already-open trades continue to
        pass.
      </p>
      <div className="list-stack">
        {guardians.length === 0 ? (
          <EmptyState
            body="Link an MT5 account to set a drawdown threshold. Breaches will pause new opens automatically."
            glyph={<ShieldCheck aria-hidden="true" size={28} />}
            title="No accounts under guard"
          />
        ) : null}
        {guardians.map((guardian) => {
          const thresholdValid =
            Number.isFinite(guardian.threshold) &&
            guardian.threshold >= 0.1 &&
            guardian.threshold <= 100;
          const thresholdHelpId = `guardian-threshold-help-${guardian.accountId}`;
          const tone = guardian.enabled
            ? severity(guardian.currentDrawdown, guardian.threshold)
            : "ok";
          const ratio =
            guardian.threshold > 0
              ? Math.min(100, (guardian.currentDrawdown / guardian.threshold) * 100)
              : 0;
          return (
            <form
              className="row-item guardian-row"
              key={guardian.accountId}
              onSubmit={(event) => {
                event.preventDefault();
                onSave(guardian.accountId, event.currentTarget);
              }}
            >
              <div className="guardian-row-head">
                <strong>{guardian.accountNumber || guardian.accountId}</strong>
                <span className={`guardian-status guardian-status-${tone}`}>
                  {!guardian.enabled
                    ? "Off"
                    : guardian.paused
                      ? "Paused for new opens"
                      : tone === "breach"
                        ? "Threshold reached"
                        : tone === "warn"
                          ? "Approaching threshold"
                          : "Accepting new opens"}
                </span>
              </div>
              <div
                aria-label={`Drawdown ${formatPercent(guardian.currentDrawdown, { locale })} of ${formatPercent(guardian.threshold, { locale })} threshold`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(ratio)}
                className={`guardian-meter guardian-meter-${tone}`}
                role="progressbar"
              >
                <span className="guardian-meter-fill" style={{ width: `${ratio}%` }} />
              </div>
              <div className="guardian-numbers">
                <span>
                  Current{" "}
                  <strong
                    className={
                      tone === "breach"
                        ? "money money-danger"
                        : tone === "warn"
                          ? "money money-warn"
                          : "money"
                    }
                  >
                    {formatPercent(guardian.currentDrawdown, { locale })}
                  </strong>
                </span>
                <span>
                  Threshold{" "}
                  <strong className="money money-muted">
                    {formatPercent(guardian.threshold, { locale })}
                  </strong>
                </span>
              </div>
              <div className="guardian-actions">
                <label className="config-toggle" htmlFor={`guardian-enabled-${guardian.accountId}`}>
                  <Switch
                    aria-label={`Enable guardian for ${guardian.accountNumber || guardian.accountId}`}
                    defaultChecked={guardian.enabled}
                    id={`guardian-enabled-${guardian.accountId}`}
                    name="enabled"
                  />
                  <span>Enabled</span>
                </label>
                <NumberField
                  aria-label="Threshold percent"
                  aria-describedby={!thresholdValid ? thresholdHelpId : undefined}
                  aria-invalid={!thresholdValid}
                  defaultValue={guardian.threshold}
                  max="100"
                  min="0.1"
                  name="threshold"
                  required={guardian.enabled}
                  step="0.1"
                  unit="%"
                />
                {!thresholdValid ? (
                  <span className="guardian-field-error" id={thresholdHelpId}>
                    Stored threshold must be between 0.1% and 100%. Correct it before enabling.
                  </span>
                ) : null}
                <button className="btn btn-primary btn-small" type="submit">
                  Save
                </button>
                {guardian.paused ? (
                  <button
                    className="btn btn-ghost btn-small"
                    onClick={() => {
                      if ((guardianHeldCounts[guardian.accountId] ?? 0) > 0) {
                        setUnpauseChoice(guardian);
                      } else {
                        onUnpause(guardian.accountId, false);
                      }
                    }}
                    type="button"
                  >
                    Unpause
                  </button>
                ) : null}
              </div>
            </form>
          );
        })}
      </div>
      {unpauseChoice ? (
        <ConfirmDialog
          cancelLabel="Keep paused"
          confirmLabel={`Unpause and requeue ${guardianHeldCounts[unpauseChoice.accountId]} held trade${guardianHeldCounts[unpauseChoice.accountId] === 1 ? "" : "s"}`}
          description="Choose whether to release guardian-held trades at market after unpausing. Lifecycle commands that arrived while held are not replayed automatically."
          destructive={false}
          onCancel={() => setUnpauseChoice(null)}
          onConfirm={() => {
            setUnpauseChoice(null);
            onUnpause(unpauseChoice.accountId, true);
          }}
          onSecondary={() => {
            setUnpauseChoice(null);
            onUnpause(unpauseChoice.accountId, false);
          }}
          secondaryLabel="Unpause only"
          title="Unpause Equity Guardian?"
        />
      ) : null}
    </Panel>
  );
}
