import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  applyColorAccents,
  ColorAccentsProvider,
  readColorAccents,
} from "./contexts/ColorAccentsContext";
import { LocaleProvider } from "./contexts/LocaleContext";
import { applyTheme, readTheme, ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./contexts/ToastContext";
// Self-hosted variable fonts — Vite emits hashed WOFF2 assets at build time
// so there are no render-blocking Google Fonts requests on cold start.
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/ibm-plex-sans";
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/motion.css";
import "./styles/base.css";
import "./styles/signal-desk.css";

if (typeof window !== "undefined") {
  applyTheme(readTheme());
  applyColorAccents(readColorAccents());
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[unhandledrejection]", event.reason);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallbackLabel="The console hit an unexpected error">
      <LocaleProvider>
        <ThemeProvider>
          <ColorAccentsProvider>
            <ToastProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ToastProvider>
          </ColorAccentsProvider>
        </ThemeProvider>
      </LocaleProvider>
    </ErrorBoundary>
  </StrictMode>,
);
