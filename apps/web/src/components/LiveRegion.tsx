import { LIVE_REGION_ID } from "../hooks/useAnnouncer";

export function LiveRegion() {
  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="visually-hidden"
      id={LIVE_REGION_ID}
      role="status"
    />
  );
}
