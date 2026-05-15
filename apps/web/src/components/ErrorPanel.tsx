import { AlertCircle, RefreshCw } from "lucide-react";

export function ErrorPanel({
  title = "Couldn't load",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-panel" role="alert">
      <div className="error-panel-glyph" aria-hidden="true">
        <AlertCircle size={18} />
      </div>
      <div className="error-panel-body">
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      {onRetry ? (
        <button className="btn btn-ghost btn-small" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={13} />
          Retry
        </button>
      ) : null}
    </div>
  );
}
