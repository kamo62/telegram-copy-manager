import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Panel } from "../components/Panel";
import {
  type AccountMappingPayload,
  type GlobalAliasPayload,
  SymbolMappingModal,
} from "../components/SymbolMappingModal";
import { type SymbolMappingRowData, SymbolMappingsTable } from "../components/SymbolMappingsTable";

export function SymbolSettingsPage({
  mappings,
  defaultAccountId,
  availableBrokerSymbols,
  defaultProviderId,
  onSaveGlobalAlias,
  onSaveAccountMapping,
  onDelete,
  loading = false,
}: {
  mappings: SymbolMappingRowData[];
  defaultAccountId: string;
  availableBrokerSymbols: string[];
  defaultProviderId?: string;
  onSaveGlobalAlias: (payload: GlobalAliasPayload) => Promise<void> | void;
  onSaveAccountMapping: (payload: AccountMappingPayload) => Promise<void> | void;
  onDelete: (mapping: SymbolMappingRowData) => void;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return mappings;
    return mappings.filter((mapping) =>
      [mapping.rawSymbol, mapping.canonicalSymbol, mapping.brokerSymbol, mapping.scope]
        .filter(Boolean)
        .some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [mappings, filter]);

  return (
    <>
      <Panel className="wide-panel" title="Symbol Mapping">
        <div className="panel-toolbar panel-toolbar-split">
          <label className="panel-search">
            <Search aria-hidden="true" size={13} />
            <input
              aria-label="Filter symbol mappings"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by raw, canonical, broker…"
              type="search"
              value={filter}
            />
          </label>
          <button
            className="btn btn-primary btn-small"
            onClick={() => setMappingModalOpen(true)}
            type="button"
          >
            Add mapping
          </button>
        </div>
        <SymbolMappingsTable loading={loading} mappings={filtered} onDelete={onDelete} />
        {filter && filtered.length === 0 && mappings.length > 0 ? (
          <p className="panel-hint">No mappings match "{filter}".</p>
        ) : null}
      </Panel>
      <SymbolMappingModal
        availableBrokerSymbols={availableBrokerSymbols}
        defaultAccountId={defaultAccountId}
        defaultProviderId={defaultProviderId}
        onClose={() => setMappingModalOpen(false)}
        onSaveAccountMapping={async (payload) => {
          await onSaveAccountMapping(payload);
          setMappingModalOpen(false);
        }}
        onSaveGlobalAlias={async (payload) => {
          await onSaveGlobalAlias(payload);
          setMappingModalOpen(false);
        }}
        open={mappingModalOpen}
      />
    </>
  );
}
