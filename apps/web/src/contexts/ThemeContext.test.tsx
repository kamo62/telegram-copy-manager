import "../test-setup";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readTheme, THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./ThemeContext";

function Control() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme} type="button">
      {theme}
    </button>
  );
}

describe("ThemeContext", () => {
  test("persists and applies an explicit light or dark preference", async () => {
    window.localStorage.clear();
    applyTheme("light");
    expect(readTheme()).toBe("light");

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ThemeProvider>
          <Control />
        </ThemeProvider>,
      ),
    );
    expect(host.textContent).toBe("light");

    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    expect(host.textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await act(async () => root.unmount());
  });
});
