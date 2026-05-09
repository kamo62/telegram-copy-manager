import { createApi } from "./app";

const port = Number(process.env.PORT ?? 8787);
const rootStaticPath = "apps/web/dist";
const devStaticPath = new URL("../../web/dist", import.meta.url).pathname;
const staticRoot =
  process.env.WEB_STATIC_ROOT ??
  ((await Bun.file(`${rootStaticPath}/index.html`).exists()) ? rootStaticPath : devStaticPath);
const app = createApi({ staticRoot });

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Telegram TC API listening on http://127.0.0.1:${port}`);
