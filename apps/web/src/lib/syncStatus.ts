import { useSyncExternalStore } from "react";

/**
 * Sync-clock state lives outside React state so the every-few-seconds SSE
 * reloads only re-render the status bar subscriber, not the whole app tree.
 */
export interface SyncStatus {
  lastSyncAt: string | null;
  refreshing: boolean;
}

let status: SyncStatus = { lastSyncAt: null, refreshing: false };
const listeners = new Set<() => void>();

export function setSyncStatus(patch: Partial<SyncStatus>) {
  const next = { ...status, ...patch };
  if (next.lastSyncAt === status.lastSyncAt && next.refreshing === status.refreshing) return;
  status = next;
  for (const listener of listeners) listener();
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => status,
    () => status,
  );
}
