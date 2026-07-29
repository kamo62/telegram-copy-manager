import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/Panel";
import {
  type AccountMappingPayload,
  type BrokerSymbolMetadata,
  type GlobalAliasPayload,
  SymbolMappingModal,
  type SymbolMappingSeed,
} from "../components/SymbolMappingModal";
import { type SymbolMappingRowData, SymbolMappingsTable } from "../components/SymbolMappingsTable";
import { apiGet } from "../lib/api";

export function SymbolSettingsPage({
  mappings,
  defaultAccountId,
  availableBrokerSymbols,
  defaultProviderId,
  onSaveGlobalAlias,
  onSaveAccountMapping,
  onDelete,
  loading = false,
  mappingSeed,
  onMappingSeedConsumed,
}: {
  mappings: SymbolMappingRowData[];
  defaultAccountId: string;
  availableBrokerSymbols: string[];
  defaultProviderId?: string;
  onSaveGlobalAlias: (payload: GlobalAliasPayload) => Promise<void> | void;
  onSaveAccountMapping: (payload: AccountMappingPayload) => Promise<void> | void;
  onDelete: (mapping: SymbolMappingRowData) => void;
  loading?: boolean;
  mappingSeed?: SymbolMappingSeed | null;
  onMappingSeedConsumed?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [activeMappingSeed, setActiveMappingSeed] = useState<SymbolMappingSeed | null>(null);
  const [symbolMetadata, setSymbolMetadata] = useState<BrokerSymbolMetadata[]>([]);
  useEffect(() => {
    if (!mappingSeed) return;
    setActiveMappingSeed(mappingSeed);
    setMappingModalOpen(true);
  }, [mappingSeed]);
  useEffect(() => {
    if (!mappingModalOpen || !defaultAccountId) return;
    let active = true;
    void apiGet<{ symbols?: BrokerSymbolMetadata[] }>(
      `/api/accounts/${defaultAccountId}/symbol-metadata`,
    )
      .then((data) => {
        if (active) setSymbolMetadata(Array.isArray(data.symbols) ? data.symbols : []);
      })
      .catch(() => {
        if (active) setSymbolMetadata([]);
      });
    return () => {
      active = false;
    };
  }, [defaultAccountId, mappingModalOpen]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return mappings;
    return mappings.filter((mapping) =>
      [mapping.rawSymbol, mapping.canonicalSymbol, mapping.brokerSymbol, mapping.scope]
        .filter(Boolean)
        .some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [mappings, filter]);

  function closeMappingModal() {
    setMappingModalOpen(false);
    setActiveMappingSeed(null);
    onMappingSeedConsumed?.();
  }

  return (
    <>
      <Panel
        actions={
          <button
            className="btn btn-primary btn-small"
            onClick={() => setMappingModalOpen(true)}
            type="button"
          >
            Add mapping
          </button>
        }
        className="wide-panel"
        title="Symbol Mapping"
      >
        <div className="panel-toolbar">
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
        </div>
        <SymbolMappingsTable loading={loading} mappings={filtered} onDelete={onDelete} />
        {filter && filtered.length === 0 && mappings.length > 0 ? (
          <p className="panel-hint">No mappings match "{filter}".</p>
        ) : null}
      </Panel>
      <SymbolMappingModal
        availableBrokerSymbols={availableBrokerSymbols}
        brokerSymbolMetadata={symbolMetadata}
        defaultAccountId={defaultAccountId}
        defaultProviderId={defaultProviderId}
        initialMapping={activeMappingSeed ?? undefined}
        key={mappingModalOpen ? "open" : "closed"}
        onClose={closeMappingModal}
        onSaveAccountMapping={async (payload) => {
          await onSaveAccountMapping(payload);
          closeMappingModal();
        }}
        onSaveGlobalAlias={async (payload) => {
          await onSaveGlobalAlias(payload);
          closeMappingModal();
        }}
        open={mappingModalOpen}
      />
    </>
  );
}
