import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { buildDiagnostics } from "../lib/diagnostics";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackLabel?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  copyState: "idle" | "copied";
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, copyState: "idle" };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  reset = (): void => {
    this.setState({ error: null, copyState: "idle" });
    this.props.onReset?.();
  };

  copyDiagnostics = async (): Promise<void> => {
    const { error } = this.state;
    if (!error) return;
    const payload = buildDiagnostics(error);
    try {
      await navigator.clipboard.writeText(payload);
      this.setState({ copyState: "copied" });
      window.setTimeout(() => this.setState({ copyState: "idle" }), 2000);
    } catch {
      // ignore — clipboard permission denied or unavailable
    }
  };

  render(): ReactNode {
    const { error, copyState } = this.state;
    if (!error) return this.props.children;
    const label = this.props.fallbackLabel ?? "Something went wrong";
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-inner">
          <div className="error-boundary-glyph" aria-hidden="true">
            <AlertTriangle size={28} />
          </div>
          <h2 className="error-boundary-title">{label}</h2>
          <p className="error-boundary-body">
            An unexpected error stopped this view from rendering. The rest of the console keeps
            working. You can retry, or copy the diagnostics for support.
          </p>
          <details className="error-boundary-details">
            <summary>Technical detail</summary>
            <pre>
              {error.name}: {error.message}
            </pre>
          </details>
          <div className="error-boundary-actions">
            <button className="btn btn-ghost" onClick={this.reset} type="button">
              <RefreshCw aria-hidden="true" size={13} />
              Retry
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void this.copyDiagnostics()}
              type="button"
            >
              <Copy aria-hidden="true" size={13} />
              {copyState === "copied" ? "Copied" : "Copy diagnostics"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
