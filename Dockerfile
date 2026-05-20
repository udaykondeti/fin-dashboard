# Multi-stage build for fin-dashboard.
# Stage 1: build the v2 React client (Vite)
# Stage 2: install server prod deps with native-module build tools available
# Stage 3: tiny runtime image — only what the server actually needs at runtime

# ---- Stage 1: client build ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
# Install client deps first so they cache when only source changes
COPY client/package.json client/package-lock.json* ./
RUN npm install --silent --no-audit --no-fund
COPY client/ ./
RUN npm run build
# Output: /app/client/dist

# ---- Stage 2: server prod deps (need build tools for better-sqlite3) ----
FROM node:20-alpine AS server-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --silent --no-audit --no-fund

# ---- Stage 3: runtime ----
FROM node:20-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/udaykondeti/fin-dashboard"
LABEL org.opencontainers.image.description="fin.kirakon.com — personal finance dashboard"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
# /app/data is a volume mount on EC2 so the SQLite file persists across
# container restarts. Default DB_PATH points inside the container.
ENV DB_PATH=/app/data/finance.db

# Install runtime utilities only (curl for healthcheck)
RUN apk add --no-cache curl tini

# Server prod node_modules (incl. better-sqlite3 native binding)
COPY --from=server-deps /app/node_modules ./node_modules
# Built React client
COPY --from=client-build /app/client/dist ./client/dist
# Server source + v1 static frontend + minimal manifest
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
# Ship maintenance / seed scripts in the image so they can be invoked
# from the running container via `docker exec ... node /app/scripts/<name>.js`.
COPY scripts/ ./scripts/

# Make sure the data dir exists; mount over it on the host
RUN mkdir -p /app/data

EXPOSE 3001

# tini reaps zombies and forwards signals to node properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3001/api/health || exit 1
