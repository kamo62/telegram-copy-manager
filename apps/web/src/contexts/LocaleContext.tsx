import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

interface LocaleContextValue {
  locale: string;
  setLocale: (locale: string) => void;
}

const STORAGE_KEY = "tg-tc.locale";

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function detectLocale(): string {
  const stored = readStoredLocale();
  if (stored) return stored;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en-US",
  setLocale: () => {
    /* no-op default */
  },
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<string>(() => detectLocale());

  const setLocale = useCallback((next: string) => {
    setLocaleState(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore quota / privacy errors */
      }
    }
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
