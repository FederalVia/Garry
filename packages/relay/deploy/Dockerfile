# Example image for the Automaton reference relay. Build from the repository root:
#   docker build -f packages/relay/deploy/Dockerfile -t automaton-relay .
# Run, published on loopback only:
#   docker run -d --name automaton-relay -p 127.0.0.1:8787:8787 -v automaton-relay:/data automaton-relay
# Not built in CI; systemd plus node is the tested path.

FROM node:20.18-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/relay/package.json packages/relay/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @automaton/relay...
COPY tsconfig.json ./
COPY packages/relay packages/relay
RUN pnpm --filter @automaton/relay build \
 && pnpm --filter @automaton/relay deploy --prod --legacy /out

FROM node:20.18-bookworm-slim
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_DB=/data/relay.db
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
