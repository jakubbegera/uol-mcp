# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
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
RUN mkdir -p /data && chown node:node /data
USER node
# Exported invoices and downloaded documents land here; mount a host folder to keep them.
VOLUME /data
ENTRYPOINT ["node", "dist/index.js"]
