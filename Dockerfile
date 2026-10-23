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
RUN mkdir -p /data
EXPOSE 3001
# fix202: the web process (dist/web.js) starts the worker (dist/worker.js) as a child process; WORKER=0 = one process
CMD ["node", "--max-old-space-size=512", "dist/web.js"]
