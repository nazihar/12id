# One image for agent-service, endorser-service, platform-api and biometric-service (Phase 2 A10, Phase 3 P9,
# Phase 6 B1); the
# compose file picks the entry script. Node 22.20 runs the TypeScript sources directly; no tsx (Phase 0 finding).
FROM node:22.20.0-bookworm-slim

WORKDIR /app

# Workspace manifests first, so the dependency layer is cached across source changes.
# The native binding packages fetch prebuilt linux-x64 libraries during install.
COPY package.json package-lock.json ./
COPY credo-base/package.json credo-base/
COPY agent-service/package.json agent-service/
COPY endorser-service/package.json endorser-service/
COPY biometric-service/package.json biometric-service/
COPY platform-api/package.json platform-api/
COPY spikes/package.json spikes/
RUN npm ci --omit=dev && npm cache clean --force

COPY credo-base/src credo-base/src
COPY agent-service/src agent-service/src
COPY agent-service/drizzle agent-service/drizzle
COPY endorser-service/src endorser-service/src
COPY endorser-service/drizzle endorser-service/drizzle
COPY biometric-service/src biometric-service/src
COPY biometric-service/drizzle biometric-service/drizzle
COPY platform-api/src platform-api/src
COPY platform-api/drizzle platform-api/drizzle

USER node
ENTRYPOINT ["node"]
CMD ["agent-service/src/main.ts"]
