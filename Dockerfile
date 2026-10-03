# syntax=docker/dockerfile:1
# WG Gefunden! (wgg). Build: docker build -t wgg:latest .
# Runtime config (db, config/*.yaml, .env) is mounted, never baked in. See deploy/compose.yml.

# --- production dependencies (native better-sqlite3 is built here, same Debian as the runtime image) ---
FROM node:22-bookworm AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# --- frontend build (dev dependencies: vite, react plugin, less) ---
FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile && yarn cache clean
COPY vite.config.js index.html ./
COPY public ./public
COPY ui ./ui
RUN yarn build:frontend

# --- runtime ---
FROM node:22-bookworm-slim AS runtime

# Shared libraries of CloakBrowser's Chromium + fonts (umlauts, emoji) + CA certificates for HTTPS to the LLM/SMTP hosts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY config ./config
COPY --from=build /app/ui/dist ./ui/dist
# The server's email composer imports the UI's (dependency-free) formatting module.
COPY ui/src/services/format.js ./ui/src/services/format.js

# Persistent state: db/ and config/ are bind mounts, .cloakbrowser (downloaded Chromium, ~700 MB) a named volume.
# The unprivileged "node" user (uid 1000) must own them; mounted host folders need the same owner (chown 1000:1000).
RUN mkdir -p db .cloakbrowser && chown -R node:node /app/db /app/.cloakbrowser /app/config
USER node
VOLUME ["/app/db", "/app/.cloakbrowser"]

EXPOSE 9998
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9998/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "bin/wgg.js", "run"]
