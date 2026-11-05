# syntax=docker/dockerfile:1
# The build output is plain JavaScript with no native modules, so it is compiled once on the
# runner's own platform; only the small runtime stage is assembled per target platform
# (a multi-arch build would otherwise run npm ci and tsc under QEMU emulation).
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
# Ownership proof for the official MCP Registry (must equal server.json "name").
LABEL io.modelcontextprotocol.server.name="eu.humblecode/uol"
LABEL org.opencontainers.image.title="uol-mcp" \
      org.opencontainers.image.description="Unofficial MCP server for the UOL Účetnictví accounting API" \
      org.opencontainers.image.source="https://github.com/jakubbegera/uol-mcp" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    UOL_DOWNLOAD_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
# The server needs only node; the package managers bundled with the base image (and the
# advisories they carry) don't ship.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data && chown node:node /data
USER node
# Exported invoices and downloaded documents land here; mount a host folder to keep them.
VOLUME /data
ENTRYPOINT ["node", "dist/index.js"]
