import { useCallback } from "react";

export const LIVE_REGION_ID = "tg-tc-live-region";

export function useAnnouncer() {
  return useCallback((message: string, priority: "polite" | "assertive" = "polite") => {
    if (typeof document === "undefined") return;
    const region = document.getElementById(LIVE_REGION_ID);
    if (!region) return;
    region.setAttribute("aria-live", priority);
    region.textContent = "";
    window.requestAnimationFrame(() => {
      region.textContent = message;
    });
  }, []);
}
