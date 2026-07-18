import { dirname, join } from "node:path";
import { archiveStaticAssets, createApi } from "./app";

const port = Number(process.env.PORT ?? 8787);
const rootStaticPath = "apps/web/dist";
const devStaticPath = new URL("../../web/dist", import.meta.url).pathname;
const staticRoot =
  process.env.WEB_STATIC_ROOT ??
  ((await Bun.file(`${rootStaticPath}/index.html`).exists()) ? rootStaticPath : devStaticPath);
const databasePath = process.env.DATABASE_PATH ?? "data/telegram-tc.db";
const assetArchiveRoot =
  process.env.ASSET_ARCHIVE_ROOT ?? join(dirname(databasePath), "asset-archive");
const assetArchive = archiveStaticAssets(staticRoot, assetArchiveRoot);
const app = createApi({
  assetArchiveRoot,
  databasePath,
  staticRoot,
  seedDemoData: process.env.SEED_DEMO_DATA === "true",
});

Bun.serve({
  port,
  // Long-lived SSE (/api/events) must outlast Bun's default idle timeout (~10s),
  // otherwise idle connections are closed mid-stream and the browser's
  // EventSource reconnects in a loop (ERR_INCOMPLETE_CHUNKED_ENCODING in Chrome).
  // 255s is Bun's max; the SSE heartbeat (every 10s) keeps the socket active.
  idleTimeout: 255,
  fetch: app.fetch,
});

console.log(`Telegram TC API listening on http://127.0.0.1:${port}`);
console.log(
  `Static asset archive ready (${assetArchive.retained} retained, ${assetArchive.pruned} pruned)`,
);
