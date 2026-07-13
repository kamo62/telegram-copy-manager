import { SkeletonRow } from "./Skeleton";
import { Tag } from "./Tag";

export interface SymbolMappingRowData {
  rawSymbol: string;
  canonicalSymbol: string;
  brokerSymbol: string;
  status: string;
  scope?: string;
  providerId?: string;
  accountId?: string;
}

export function SymbolMappingsTable({
  mappings,
  onDelete,
  loading = false,
}: {
  mappings: SymbolMappingRowData[];
  onDelete?: (mapping: SymbolMappingRowData) => void;
  loading?: boolean;
}) {
  return (
    <div className="data-table-wrap">
      <table className="data-table symbol-mappings-table">
        <thead>
          <tr>
            <th scope="col">Provider symbol</th>
            <th scope="col">Canonical</th>
            <th scope="col">Broker symbol</th>
            <th scope="col">Scope</th>
            <th scope="col">Status</th>
            <th aria-label="Actions" scope="col" />
          </tr>
        </thead>
        <tbody>
          {loading && mappings.length === 0
            ? Array.from({ length: 6 }, (_, index) => (
                <SkeletonRow columns={6} key={`mapping-skeleton-${index}`} />
              ))
            : null}
          {!loading && mappings.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={6}>No symbol mappings yet.</td>
            </tr>
          ) : null}
          {mappings.map((mapping) => (
            <tr key={`${mapping.rawSymbol}-${mapping.brokerSymbol}`}>
              <th className="data-table-row-head" scope="row">
                <strong>{mapping.rawSymbol}</strong>
              </th>
              <td className="mapping-canonical">{mapping.canonicalSymbol}</td>
              <td className="mapping-broker">{mapping.brokerSymbol}</td>
              <td>{mapping.scope ?? "global"}</td>
              <td>
                <Tag tone={mapping.status === "mapped" ? "good" : "warn"}>{mapping.status}</Tag>
              </td>
              <td>
                {onDelete && mapping.scope !== "account" ? (
                  <button
                    className="btn btn-ghost btn-small btn-destructive-subtle"
                    onClick={() => onDelete(mapping)}
                    type="button"
                  >
                    Delete
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
