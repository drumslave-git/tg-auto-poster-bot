# syntax=docker/dockerfile:1

# Multi-stage build for the self-hosted bot: compile the server and the
# dashboard with the full dependency tree, then ship a slim runtime that has
# only the production dependencies — built inside the image so the native
# better-sqlite3 binary matches the container's platform. Never copy host
# node_modules in.

FROM node:24-alpine AS base
WORKDIR /app

# better-sqlite3 publishes no musl prebuild, so npm compiles it from source and
# needs a toolchain. Only the stages that install dependencies pay for this.
FROM base AS toolchain
RUN apk add --no-cache python3 make g++

# --- deps: full install (incl. dev) for building ---
# `npm install` (not `npm ci`) so platform-specific optional native deps resolve
# at build time even when package-lock.json was generated on another OS.
FROM toolchain AS deps
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# --- builder: compile the server (tsc) and bundle the dashboard (vite) ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- prod-deps: runtime dependencies only, compiled for this image ---
FROM toolchain AS prod-deps
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runner: what actually ships ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Migrations are applied at boot, resolved against the working directory.
COPY drizzle ./drizzle
COPY package.json ./

# Pre-create the data directory so a named volume is writable by the non-root
# user; a host bind mount has to be made writable by that user on the host side.
RUN mkdir -p /app/data \
    && addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app
USER app

EXPOSE 3000

# The server migrates the database before it starts listening, so a failed
# migration fails the start instead of serving against an old schema.
CMD ["node", "dist/server/index.js"]
