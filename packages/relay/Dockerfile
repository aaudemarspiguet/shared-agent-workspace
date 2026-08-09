# The SAW relay in a container (Principle VII: small and self-hostable).
#
# Build from the repository root, not from this folder:
#
#   docker build -f packages/relay/Dockerfile -t saw-relay .
#
# The context must be the root because the relay uses the workspace
# package @saw/shared, and npm needs the root manifest and lockfile.

FROM node:20-alpine

# better-sqlite3 compiles from source when no prebuilt binary matches
# this platform. These packages make that build work.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy the manifests first, so Docker caches the install layer and
# re-runs it only when a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/relay/package.json packages/relay/
COPY packages/cli/package.json packages/cli/
COPY tests/integration/package.json tests/integration/

# Install the relay workspace and the root dev tools (tsx runs the
# TypeScript source directly; there is no build step).
RUN npm ci --workspace @saw/relay --include-workspace-root

COPY packages/shared packages/shared
COPY packages/relay packages/relay

# The database lives on a volume, so it survives container restarts.
ENV SAW_RELAY_PORT=8787
ENV SAW_RELAY_DB=/data/saw-relay.db
RUN mkdir -p /data
VOLUME /data

EXPOSE 8787

CMD ["npx", "tsx", "packages/relay/src/index.ts"]
