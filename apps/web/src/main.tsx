import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocaleProvider } from "./contexts/LocaleContext";
import { ToastProvider } from "./contexts/ToastContext";
// Self-hosted variable fonts — Vite emits hashed WOFF2 assets at build time
// so there are no render-blocking Google Fonts requests on cold start.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/motion.css";
import "./styles/base.css";

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[unhandledrejection]", event.reason);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallbackLabel="The console hit an unexpected error">
      <LocaleProvider>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </LocaleProvider>
    </ErrorBoundary>
  </StrictMode>,
);
