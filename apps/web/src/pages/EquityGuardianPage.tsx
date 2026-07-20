import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
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
    <Panel className="wide-panel" title="Equity Guardian">
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
                <label className="config-toggle">
                  <input defaultChecked={guardian.enabled} name="enabled" type="checkbox" />
                  <span>On</span>
                </label>
                <input
                  aria-label="Threshold percent"
                  defaultValue={guardian.threshold || 10}
                  min="0"
                  name="threshold"
                  required={guardian.enabled}
                  step="0.1"
                  type="number"
                />
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
