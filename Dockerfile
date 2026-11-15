# syntax=docker/dockerfile:1
#
# The automaton in a container: guard code read-only, a non-root user, and
# the owner's files mounted read-only (see deploy/docker-compose.yml and
# docs/deployment.md).
#
# The base image is pinned by digest so a rebuild cannot pick up a different
# image. scripts/pin-base-image.sh resolves the current digest of the tag and
# writes it here (it needs network access to the registry); review the diff.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Same pnpm as packageManager in package.json.
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile
COPY . .
# A fresh production install rather than `pnpm prune --prod`: prune empties
# packages/cli/node_modules, which drops the CLI's link to the runtime.
RUN pnpm run build \
 && rm -rf node_modules packages/*/node_modules \
 && CI=true pnpm install --frozen-lockfile --prod --filter @conway/automaton --filter @conway/automaton-cli

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 automaton \
 && useradd --uid 10001 --gid 10001 --home-dir /home/automaton --create-home --shell /usr/sbin/nologin automaton \
 && install -d -o 10001 -g 10001 -m 0700 /home/automaton/.automaton
WORKDIR /app
# Root-owned and not writable by the agent user: the guard code and the build
# stay as built. Self-modification of the runtime is off in the container.
COPY --from=build --chown=root:root /src/package.json /src/constitution.md ./
COPY --from=build --chown=root:root /src/dist ./dist
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/packages/cli/package.json ./packages/cli/
COPY --from=build --chown=root:root /src/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=root:root /src/packages/cli/node_modules ./packages/cli/node_modules
COPY --chown=root:root --chmod=0555 deploy/entrypoint.sh /usr/local/bin/automaton-entrypoint
ENV HOME=/home/automaton NODE_ENV=production
USER 10001:10001
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "/app/dist/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/automaton-entrypoint"]
CMD ["run"]
