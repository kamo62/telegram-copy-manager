import { Settings as SettingsIcon } from "lucide-react";
import { Tag } from "./Tag";

export interface ProviderRowData {
  id: string;
  title: string;
  enabled: boolean;
  parserMode: string;
  riskProfile?: string;
  lotSize: number;
  lastMessageAt: string;
}

const numFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function lotsLabel(value: number): string {
  return numFmt.format(value);
}

export function ProvidersTable({
  providers,
  onConfigure,
  onToggle,
}: {
  providers: ProviderRowData[];
  onConfigure: (provider: ProviderRowData) => void;
  onToggle: (provider: ProviderRowData) => void;
}) {
  return (
    <div className="data-table-wrap">
      <table className="data-table providers-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th className="num" scope="col">
              Lots
            </th>
            <th className="num" scope="col">
              TP #
            </th>
            <th className="num" scope="col">
              SL
            </th>
            <th className="num" scope="col">
              Pips
            </th>
            <th className="num" scope="col">
              W/L %
            </th>
            <th className="num" scope="col">
              Avg. drawdown
            </th>
            <th className="num" scope="col">
              P/L
            </th>
            <th className="num" scope="col">
              Profit
            </th>
            <th className="num" scope="col">
              Gain
            </th>
            <th scope="col">Status</th>
            <th aria-label="Actions" scope="col" />
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={12}>No providers configured yet. Add one from Telegram Setup.</td>
            </tr>
          ) : null}
          {providers.map((provider) => (
            <tr key={provider.id}>
              <th className="data-table-row-head" scope="row">
                <strong>{provider.title}</strong>
                <span className="data-table-subtle">
                  {provider.parserMode} · {formatRelative(provider.lastMessageAt)}
                </span>
              </th>
              <td className="num-cell">{lotsLabel(provider.lotSize)}</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td>
                <Tag tone={provider.enabled ? "good" : "muted"}>
                  {provider.enabled ? "Auto-copy enabled" : "Provider paused"}
                </Tag>
              </td>
              <td className="data-table-actions">
                <button
                  aria-label={`Configure ${provider.title}`}
                  className="icon-btn"
                  onClick={() => onConfigure(provider)}
                  title={`Configure ${provider.title}`}
                  type="button"
                >
                  <SettingsIcon size={14} aria-hidden="true" />
                </button>
                <button
                  aria-label={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
                  className="row-btn"
                  onClick={() => onToggle(provider)}
                  type="button"
                >
                  {provider.enabled ? "Pause" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}
