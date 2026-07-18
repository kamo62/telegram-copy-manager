import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import packageJson from "../../package.json";

export default defineConfig(({ mode }) => ({
  define: {
    "globalThis.__APP_VERSION__": JSON.stringify(packageJson.version),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    // Keep sourcemaps in dev for debugging; drop them from the prod build to
    // avoid serving ~1.3 MB of map files alongside the 340 KB app bundle.
    sourcemap: mode !== "production",
    rollupOptions: {
      output: {
        // Split long-lived vendor code into its own chunks so an app-code
        // redeploy doesn't bust the React / icons cache.
        manualChunks(id) {
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
          if (id.includes("/node_modules/lucide-react/")) return "icons-vendor";
        },
      },
    },
  },
}));
