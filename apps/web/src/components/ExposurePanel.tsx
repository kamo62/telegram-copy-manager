import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { computeExposure, type ExposurePosition, fallbackPipSize } from "../lib/exposure";

interface SymbolMeta {
  symbol: string;
  pipSize?: number | null;
}

const defaultLoad = (accountId: string) =>
  apiGet<{ symbols?: SymbolMeta[] }>(`/api/accounts/${accountId}/symbol-metadata`).then(
    (data) => data.symbols ?? [],
  );

/**
 * Aggregate open-exposure panel (Task 7). Display-only: total open lots and a
 * per-symbol breakdown of lots + volume-weighted stop distance. Self-loads
 * symbol metadata to convert stop distances to pips; falls back to per-symbol
 * defaults when metadata is missing.
 */
export function ExposurePanel({
  accountId,
  className,
  positions,
  load = defaultLoad,
}: {
  accountId: string | null;
  className?: string;
  positions: ExposurePosition[];
  load?: (accountId: string) => Promise<SymbolMeta[]>;
}) {
  const [metadata, setMetadata] = useState<SymbolMeta[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    Promise.resolve(load(accountId))
      .then((rows) => {
        if (active) setMetadata(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        /* fall back to default pip sizes on failure */
      });
    return () => {
      active = false;
    };
  }, [accountId, load]);

  if (positions.length === 0) return null;

  const pipMap = new Map(
    metadata
      .filter((m) => typeof m.pipSize === "number" && m.pipSize)
      .map((m) => [m.symbol, m.pipSize as number]),
  );
  const pipSizeFor = (symbol: string) => pipMap.get(symbol) ?? fallbackPipSize(symbol);
  const { totalLots, bySymbol } = computeExposure(positions, pipSizeFor);

  return (
    <section
      className={["exposure-panel", className].filter(Boolean).join(" ")}
      aria-label="Aggregate exposure"
    >
      <header className="exposure-head">
        <strong>Exposure</strong>
        <span className="exposure-total">{totalLots} lots open</span>
      </header>
      <div className="exposure-table-wrap">
        <table className="exposure-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Lots</th>
              <th>SL distance</th>
              <th>Risk (pip·lots)</th>
            </tr>
          </thead>
          <tbody>
            {bySymbol.map((row) => (
              <tr key={row.symbol}>
                <td>{row.symbol}</td>
                <td>{row.lots}</td>
                <td>{row.riskPips > 0 ? `${row.riskPips} pips` : "—"}</td>
                <td>{row.riskPipLots > 0 ? row.riskPipLots : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="exposure-note">
        Monetary risk needs the broker's per-symbol tick value; pip·lots is a relative magnitude.
      </p>
    </section>
  );
}
