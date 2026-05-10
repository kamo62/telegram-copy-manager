import { Tag } from "./Tag";

export interface SymbolMappingRowData {
  rawSymbol: string;
  canonicalSymbol: string;
  brokerSymbol: string;
  status: string;
}

export function SymbolMappingsTable({ mappings }: { mappings: SymbolMappingRowData[] }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table symbol-mappings-table">
        <thead>
          <tr>
            <th scope="col">Raw symbol</th>
            <th scope="col">Canonical</th>
            <th scope="col">Broker symbol</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {mappings.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={4}>No symbol mappings yet.</td>
            </tr>
          ) : null}
          {mappings.map((mapping) => (
            <tr key={`${mapping.rawSymbol}-${mapping.brokerSymbol}`}>
              <th className="data-table-row-head" scope="row">
                <strong>{mapping.rawSymbol}</strong>
              </th>
              <td className="mapping-canonical">{mapping.canonicalSymbol}</td>
              <td className="mapping-broker">{mapping.brokerSymbol}</td>
              <td>
                <Tag tone={mapping.status === "mapped" ? "good" : "warn"}>{mapping.status}</Tag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
