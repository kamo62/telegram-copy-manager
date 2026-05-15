import { Check, Copy, Hourglass, Plug } from "lucide-react";
import { useState } from "react";

interface PendingSlotViewProps {
  slot: {
    id: string;
    name: string;
    linkCode: string;
    status: string;
    accountNumber: string;
    server: string;
  };
  backendUrlHint?: string;
}

export function PendingSlotView({
  slot,
  backendUrlHint = "the URL the EA polls (set in TelegramTC_EA Inputs)",
}: PendingSlotViewProps) {
  const [copied, setCopied] = useState<"code" | null>(null);

  function copy(value: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied("code");
      window.setTimeout(() => setCopied(null), 1800);
    });
  }

  return (
    <section className="pending-slot" aria-labelledby="pending-slot-title">
      <header className="pending-slot-head">
        <div className="pending-slot-glyph" aria-hidden="true">
          <Hourglass size={22} />
        </div>
        <div className="pending-slot-head-body">
          <span className="pending-slot-eyebrow">Pending account · waiting for EA</span>
          <h2 className="pending-slot-title" id="pending-slot-title">
            {slot.name || "MT5 Account Slot"}
          </h2>
          <p className="pending-slot-subtitle">
            This slot is reserved for an MT5 Expert Advisor that hasn't checked in yet. Follow the
            steps below in MetaTrader 5 to bring it online.
          </p>
        </div>
        <div className="pending-slot-status" role="status">
          <span className="pending-slot-status-dot" aria-hidden="true" />
          Waiting for EA
        </div>
      </header>

      <div className="pending-slot-code-card">
        <div className="pending-slot-code-label">Your link code</div>
        <div className="pending-slot-code-row">
          <code className="pending-slot-code">{slot.linkCode}</code>
          <button
            aria-label="Copy link code"
            className="btn btn-ghost btn-small"
            onClick={() => copy(slot.linkCode)}
            type="button"
          >
            {copied === "code" ? (
              <>
                <Check aria-hidden="true" size={13} />
                Copied
              </>
            ) : (
              <>
                <Copy aria-hidden="true" size={13} />
                Copy
              </>
            )}
          </button>
        </div>
        <p className="pending-slot-code-hint">
          Each slot has a unique code. The first EA that registers with this code claims this slot
          and starts reporting balance, equity, and trades here.
        </p>
      </div>

      <ol className="pending-slot-steps">
        <li>
          <span className="pending-slot-step-num">1</span>
          <div>
            <strong>Allow the backend URL in MT5</strong>
            <p>
              In MetaTrader 5: <em>Tools → Options → Expert Advisors</em>, tick{" "}
              <em>"Allow WebRequest for listed URL"</em>, and add {backendUrlHint}.
            </p>
          </div>
        </li>
        <li>
          <span className="pending-slot-step-num">2</span>
          <div>
            <strong>Attach the TelegramTC EA</strong>
            <p>
              Drag <code>TelegramTC_EA</code> from the Navigator onto any chart. Allow live trading
              and DLL imports when prompted.
            </p>
          </div>
        </li>
        <li>
          <span className="pending-slot-step-num">3</span>
          <div>
            <strong>
              Paste the link code into <code>LinkCode</code>
            </strong>
            <p>
              In the EA Inputs tab, set <code>LinkCode</code> to{" "}
              <code className="pending-slot-inline-code">{slot.linkCode}</code> and save.
            </p>
          </div>
        </li>
        <li>
          <span className="pending-slot-step-num">4</span>
          <div>
            <strong>Wait for the heartbeat</strong>
            <p>
              The EA will register with the backend and this slot will turn green within a few
              seconds. The page polls every 15 seconds.
            </p>
          </div>
        </li>
      </ol>

      <footer className="pending-slot-foot">
        <Plug aria-hidden="true" size={13} />
        <span>
          Stuck? Re-check that <code>LinkCode</code> matches exactly (no trailing space) and that
          the WebRequest URL is on the allow-list.
        </span>
      </footer>
    </section>
  );
}
