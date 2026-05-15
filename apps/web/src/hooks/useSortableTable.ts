import { useMemo, useState } from "react";

type Direction = "asc" | "desc";

export function useSortableTable<T, K extends keyof T>(
  rows: T[],
  defaultKey: K,
  defaultDir: Direction = "asc",
) {
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [sortDir, setSortDir] = useState<Direction>(defaultDir);

  const sortedRows = useMemo(() => {
    return [...rows].sort((left, right) => {
      const a = left[sortKey];
      const b = right[sortKey];
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const result =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? result : -result;
    });
  }, [rows, sortDir, sortKey]);

  function toggle(key: K) {
    if (key === sortKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(defaultDir);
  }

  function sortAria(key: K) {
    if (key !== sortKey) return "none" as const;
    return sortDir === "asc" ? ("ascending" as const) : ("descending" as const);
  }

  return { sortedRows, sortKey, sortDir, toggle, sortAria };
}
