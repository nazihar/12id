# Ledger tooling (W3): one-off Credo 0.7 scripts against the staging ledger.
#
# Node 22.20 runs the TypeScript sources directly (type stripping). Do not add tsx:
# it mis-resolves webcrypto-core's dual export under Credo 0.7 (Phase 0 finding).
FROM node:22.20.0-bookworm-slim

WORKDIR /app

# The native binding packages fetch prebuilt libraries during install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
ENTRYPOINT ["node"]
CMD ["src/bootstrap-endorser.ts"]
