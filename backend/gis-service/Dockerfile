# ─── AEGIS GLOBAL — Multi-service Dockerfile template ────────────────────────
# Each service copies this pattern. Build arg SERVICE_NAME selects the service.

# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Security: non-root user
RUN addgroup --system --gid 1001 aegis && \
    adduser  --system --uid 1001 aegis

COPY --from=deps    --chown=aegis:aegis /app/node_modules ./node_modules
COPY --from=builder --chown=aegis:aegis /app/dist         ./dist

USER aegis
EXPOSE 4003
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4003/health || exit 1

CMD ["node", "dist/index.js"]
