FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && curl -fsSL https://github.com/temporalio/cli/releases/download/v1.10.1/temporal_cli_1.10.1_linux_amd64.tar.gz -o /tmp/temporal.tar.gz \
    && echo "4c1500e2ce2d4de136e5fe8852d9b7f82eb62f19b6b383b3e0c040519a9d20b1  /tmp/temporal.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/temporal.tar.gz -C /usr/local/bin temporal \
    && rm /tmp/temporal.tar.gz \
    && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
ENV NODE_ENV=production
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
