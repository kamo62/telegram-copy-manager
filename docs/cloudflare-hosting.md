# Cloudflare Hosting Notes

The app is shaped so the domain model and Hono routes can move toward Cloudflare Workers, but the current local runtime uses Bun with SQLite for fast MVP verification.

Recommended Cloudflare split:

- Use Cloudflare Workers for the API surface.
- Use D1 as the primary relational store for profiles, providers, raw messages, parsed signals, queue items, trades, MT5 accounts, and execution reports.
- Consider a Durable Object later for per-account queue coordination if multiple EAs poll aggressively or if strict single-lease behavior becomes a production issue.
- Keep Telegram `.session` files, API hashes, OTPs, and 2FA passwords out of browser storage and out of D1 rows. Store only safe profile/session metadata in D1.
- The local real Telegram adapter uses GramJS. Before a Workers deployment, validate whether the MTProto client runtime can run in the chosen Worker shape; otherwise keep Telegram ingestion in a private Bun/Node worker and use Cloudflare for the API/dashboard plus D1 state.

Cloudflare docs checked during implementation:

- D1 is Cloudflare's managed serverless SQL database for Workers and Pages.
- Workers bind D1 through `[[d1_databases]]` in Wrangler configuration.
- Durable Objects provide low-latency coordination and strongly consistent storage for a single object identity.

Useful links:

- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases
- https://developers.cloudflare.com/durable-objects/

Current porting work still needed before deployment:

- Add a Worker entrypoint that calls the same Hono route factory with a D1-backed store.
- Move the local `AppStore` SQLite implementation behind an explicit store interface.
- Apply `migrations/0001_initial.sql` to D1 through Wrangler.
- Decide whether Telegram session storage runs inside Workers, on a separate worker process, or on a private origin because MTProto client libraries may need Node-style networking/runtime support.
