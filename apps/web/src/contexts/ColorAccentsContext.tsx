import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export const COLOR_ACCENTS_STORAGE_KEY = "ttc:colorAccents";

export function readColorAccents(): boolean {
  try {
    return window.localStorage.getItem(COLOR_ACCENTS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function applyColorAccents(enabled: boolean) {
  document.documentElement.dataset.colorAccents = enabled ? "on" : "off";
}

type ColorAccentsValue = {
  colorAccents: boolean;
  setColorAccents: (enabled: boolean) => void;
};

const ColorAccentsContext = createContext<ColorAccentsValue>({
  colorAccents: true,
  setColorAccents: () => {},
});

export function ColorAccentsProvider({ children }: { children: ReactNode }) {
  const [colorAccents, setColorAccentsState] = useState(() => {
    const enabled = readColorAccents();
    applyColorAccents(enabled);
    return enabled;
  });
  const setColorAccents = useCallback((enabled: boolean) => {
    try {
      window.localStorage.setItem(COLOR_ACCENTS_STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // The preference remains live for this page when storage is unavailable.
    }
    applyColorAccents(enabled);
    setColorAccentsState(enabled);
  }, []);
  const value = useMemo(() => ({ colorAccents, setColorAccents }), [colorAccents, setColorAccents]);
  return <ColorAccentsContext value={value}>{children}</ColorAccentsContext>;
}

export function useColorAccents() {
  return useContext(ColorAccentsContext);
}
