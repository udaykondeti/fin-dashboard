# Dockerfile for udaykondeti/pippy
# Place this file at the root of the pippy repo as `Dockerfile`
FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm install --production --silent

COPY . .

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3005/health || curl -fsS http://localhost:3005/ || exit 1

CMD ["node", "server/index.js"]
