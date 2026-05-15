import { Monitor } from "lucide-react";

export function SmallViewportNotice({ onContinueAnyway }: { onContinueAnyway: () => void }) {
  return (
    <div className="small-viewport-notice" role="dialog" aria-labelledby="small-viewport-title">
      <div className="small-viewport-notice-inner">
        <div className="small-viewport-notice-glyph" aria-hidden="true">
          <Monitor size={32} />
        </div>
        <h1 className="small-viewport-notice-title" id="small-viewport-title">
          Use a larger screen
        </h1>
        <p className="small-viewport-notice-body">
          This operations console is designed for desktop. Data tables, charts, and live trade
          monitoring need more horizontal room than a phone can provide.
        </p>
        <p className="small-viewport-notice-body small-viewport-notice-body-secondary">
          Open this URL on a desktop or widen your browser window to at least 768 pixels.
        </p>
        <button
          className="btn btn-ghost small-viewport-notice-continue"
          onClick={onContinueAnyway}
          type="button"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
