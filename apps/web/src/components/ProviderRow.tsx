import { Tag } from "./Tag";

export function ProviderRow({
  provider,
  onToggle,
  onSaveSettings,
}: {
  provider: {
    id: string;
    title: string;
    enabled: boolean;
    parserMode: string;
    riskProfile: string;
    lotSize: number;
    lastMessageAt: string;
  };
  onToggle: () => void;
  onSaveSettings: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="row-item">
      <div>
        <strong>{provider.title}</strong>
        <span>
          {provider.parserMode} · {new Date(provider.lastMessageAt).toLocaleString()}
        </span>
      </div>
      <Tag tone={provider.enabled ? "good" : "muted"}>
        {provider.enabled ? "Auto-copy enabled" : "Provider paused"}
      </Tag>
      <form
        className="compact-form provider-settings"
        noValidate
        onSubmit={(event) => void onSaveSettings(event)}
      >
        <label>
          Parser mode for {provider.title}
          <select defaultValue={provider.parserMode} name="parserMode">
            <option value="deterministic">Deterministic</option>
            <option value="kal-vip">KAL VIP tuned</option>
          </select>
        </label>
        <label>
          Risk profile for {provider.title}
          <select defaultValue={provider.riskProfile} name="riskProfile">
            <option value="balanced">Balanced</option>
            <option value="conservative">Conservative</option>
            <option value="aggressive">Aggressive</option>
          </select>
        </label>
        <label>
          Channel lot size for {provider.title}
          <input
            defaultValue={provider.lotSize}
            min="0.01"
            name="lotSize"
            step="0.01"
            type="number"
          />
        </label>
        <button aria-label={`Save provider settings for ${provider.title}`} type="submit">
          Save settings
        </button>
      </form>
      <button
        aria-label={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
        onClick={() => void onToggle()}
        title={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
        type="button"
      >
        {provider.enabled ? "Pause" : "Enable"}
      </button>
    </div>
  );
}
