import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
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

const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallbackLabel="The console hit an unexpected error">
      <LocaleProvider>
        <ThemeProvider>
          <ColorAccentsProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ColorAccentsProvider>
        </ThemeProvider>
      </LocaleProvider>
    </ErrorBoundary>
  </StrictMode>,
);
