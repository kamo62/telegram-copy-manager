# Telegram TC

Telegram TC is a Telegram-to-MetaTrader 5 copy trading MVP. It combines a parser lab, provider management, symbol mapping, logical trade lifecycle tracking, an MT5 queue, and an Expert Advisor polling path.

The first release is MT5-first. Telegram and MT5 integration boundaries are present, while real Telegram auth and MT5 execution require external credentials and a demo/live terminal.

## Structure

- `apps/web`: React operations dashboard.
- `apps/api`: Bun/Hono API with local SQLite persistence.
- `packages/core`: deterministic parser, symbol resolver, lifecycle matching, and queue payload model.
- `mt5`: MetaTrader 5 Expert Advisor source.
- `migrations`: SQL schema aligned to local SQLite and future Cloudflare D1.
- `docs`: verification and hosting notes.

## Local Development

Use Bun for this project.

```bash
bun install
bun run dev:api
bun run dev:web
```

The API listens on `http://127.0.0.1:8787` and the web app on `http://127.0.0.1:5173`.

## Versioning

The root `package.json` `version` field is the canonical application version. The MT5 EA version in
`mt5/TelegramTC_EA.mq5` must stay aligned with it:

```mql5
#property version   "1.5.0"
```

Changes should be classified with SemVer before final verification. API, UI, EA payload, or workflow
additions are minor releases; backward-compatible fixes are patch releases; breaking API, DB, env, or
EA protocol changes are major releases.

## Telegram Adapter

The default Telegram adapter is `mock`, which keeps local tests deterministic. To use a real
Telegram account locally, start the API with:

```bash
TELEGRAM_ADAPTER=gramjs bun run dev:api
```

The frontend still collects `api_id`, `api_hash`, phone, code, and 2FA password, but it only keeps
safe profile/session identifiers in browser state. GramJS session strings are written under
`data/telegram-sessions/`, which is ignored by git.

## Verification

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run docker:build
```

See `docs/local-verification.md` for what can and cannot be verified without a real MT5 terminal.

## Home-Server Docker

The home-server deployment uses Docker Compose v2 through the Docker CLI plugin:

```bash
docker compose up -d --build
```

Do not use the old `docker-compose` v1 command for rebuilds; it can fail during container recreation
with `KeyError: 'ContainerConfig'` on newer Docker image metadata. Installing the Compose v2 plugin
does not delete images or restart containers by itself. The app service is configured with
`restart: unless-stopped` so it comes back after host or Docker daemon restarts.
