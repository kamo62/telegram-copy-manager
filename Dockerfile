FROM oven/bun:1.3.10 AS install
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN bun install --frozen-lockfile

FROM install AS build
COPY . .
RUN bun run build

FROM oven/bun:1.3.10 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 8787

# Catches a wedged-but-alive process. `restart: unless-stopped` only reacts to
# the process exiting, so before this a hung server ran indefinitely with no
# signal anywhere.
#
# Deliberately checks liveness, not readiness. /api/health returns 200 with
# status "degraded" while Telegram ingestion is down, and that must NOT mark the
# container unhealthy: a Telegram stall is not fixed by restarting, and a
# restart mid-stall would drop the in-memory snapshot and readiness state. The
# degraded signal is for the operator and the dashboard. This check only asks
# whether the HTTP server still answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT??8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/api/server.js"]
