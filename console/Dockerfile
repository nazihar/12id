# 12id console (Phase 4 C5). Two stages:
#   build    all dependencies + sources; `vite build`; also the image for the Better Auth CLI
#            (operator bootstrap needs the TS auth config and the `auth` dev dependency)
#   runtime  production dependencies only (the server bundle keeps them external) + dist + the
#            migration script, served by srvx. Runs as `node`, NODE_ENV=production.
FROM node:22.20.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && node scripts/check-client-bundle.ts

FROM node:22.20.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY scripts/migrate.ts ./scripts/migrate.ts
USER node
EXPOSE 3600
CMD ["node", "node_modules/srvx/bin/srvx.mjs", "--prod", "--host", "0.0.0.0", "--port", "3600", "-s", "../client", "dist/server/server.js"]
