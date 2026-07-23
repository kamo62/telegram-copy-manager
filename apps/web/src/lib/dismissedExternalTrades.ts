export const DISMISSED_EXTERNAL_TRADES_STORAGE_KEY = "ttc:dismissedExternalTrades";

export function externalTradeKey(accountId: string, ticket: string): string {
  return `${accountId}:${ticket}`;
}

export function readDismissedExternalTrades(): Set<string> {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(DISMISSED_EXTERNAL_TRADES_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function writeDismissedExternalTrades(dismissed: Set<string>) {
  try {
    window.localStorage.setItem(
      DISMISSED_EXTERNAL_TRADES_STORAGE_KEY,
      JSON.stringify([...dismissed]),
    );
  } catch {
    // The in-memory dismissal remains useful when browser storage is unavailable.
  }
}
