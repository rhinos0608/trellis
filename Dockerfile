# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# native addon build toolchain for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# prune dev deps, keep native node_modules intact
RUN npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV TRELLIS_DB_PATH=/data/trellis.db

WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# writable volume for the SQLite database
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

ENTRYPOINT ["node", "dist/cli/main.js"]
