# SportLikely — single image: Express API + built React site + SQLite on a volume.
# Node 24 (node:sqlite is built in). Used by Railway (see railway.json) or any Docker host.

# Base image from Amazon's public mirror of the official Node image: Docker Hub limits downloads (429 errors on Railway).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine

# ---- 1. build the frontend ----
FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
# vite build only (skip the tsc pass so a stray unused import can't block a deploy)
RUN npx vite build

# ---- 2. build the backend ----
FROM ${NODE_IMAGE} AS api
WORKDIR /api
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ---- 3. runtime ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    STATIC_DIR=/app/frontend/dist
WORKDIR /app/backend
COPY --from=api /api/node_modules ./node_modules
COPY --from=api /api/dist ./dist
COPY --from=api /api/package.json ./package.json
COPY --from=web /web/dist /app/frontend/dist
# guides (markdown) are rendered by the API and the crawler HTML (services/guides.ts)
COPY frontend/src/content/guides /app/frontend/src/content/guides
# fix206: the how-it-works pages' search-engine copy uses the app's translations; the changelog is a file in the repo
COPY frontend/src/locales /app/frontend/src/locales
COPY docs/changelog.json /app/docs/changelog.json
RUN mkdir -p /data
EXPOSE 3001
# fix202: two processes share the container — the web process (this one, WEB_HEAP_MB) and the worker it starts
# (WORKER_HEAP_MB, default 1536, set in index.ts). WORKER=0 runs everything in this one process.
# fix210: each heap is capped at its share of the container's memory limit (web 30%, worker 55%: utils/memLimit.ts)
CMD ["sh", "-c", "exec node --max-old-space-size=$(node dist/utils/memLimit.js web 2>/dev/null || echo ${WEB_HEAP_MB:-1024}) dist/index.js"]
