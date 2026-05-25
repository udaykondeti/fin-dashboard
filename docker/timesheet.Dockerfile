# Dockerfile for udaykondeti/Timesheet
# Place this file at the root of the Timesheet repo as `Dockerfile`
FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm install --production --silent

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || curl -fsS http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
