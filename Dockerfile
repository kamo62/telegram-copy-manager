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
CMD ["bun", "dist/api/server.js"]
