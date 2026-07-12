import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
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
        // redeploy doesn't bust the React / charts / icons cache.
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "icons-vendor": ["lucide-react"],
        },
      },
    },
  },
}));
