import { ShieldCheck } from "lucide-react";
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
}: {
  guardians: Guardian[];
  onSave: (accountId: string, form: HTMLFormElement) => void;
  onUnpause: (accountId: string) => void;
}) {
  const { locale } = useLocale();
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
          const tone = severity(guardian.currentDrawdown, guardian.threshold);
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
                  {guardian.paused
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
                  Current <strong>{formatPercent(guardian.currentDrawdown, { locale })}</strong>
                </span>
                <span>
                  Threshold <strong>{formatPercent(guardian.threshold, { locale })}</strong>
                </span>
              </div>
              <div className="guardian-actions">
                <input
                  aria-label="Threshold percent"
                  defaultValue={guardian.threshold}
                  min="0"
                  name="threshold"
                  step="0.1"
                  type="number"
                />
                <button className="btn btn-primary btn-small" type="submit">
                  Save
                </button>
                {guardian.paused ? (
                  <button
                    className="btn btn-ghost btn-small"
                    onClick={() => onUnpause(guardian.accountId)}
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
    </Panel>
  );
}
