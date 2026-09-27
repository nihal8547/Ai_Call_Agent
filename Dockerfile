# syntax=docker/dockerfile:1.7
#
# One Dockerfile, four images (build with --target):
#   api      NestJS API + Twilio webhooks        (port 4000)
#   worker   BullMQ background jobs (documents)
#   web      Next.js management app              (port 3000)
#   migrate  applies database migrations, then exits
#
# docker compose builds all of them; see docker-compose.yml and README "Docker".

ARG NODE_IMAGE=node:22-bookworm-slim

# ── base ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
# openssl: Prisma's query engine; ca-certificates: outbound HTTPS (Twilio, Google, Gemini, S3).
# Set INSTALL_SYSTEM_PACKAGES=0 with a NODE_IMAGE that already has them (e.g. node:22-bookworm)
# when the build cannot reach the Debian mirrors.
ARG INSTALL_SYSTEM_PACKAGES=1
RUN if [ "$INSTALL_SYSTEM_PACKAGES" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /repo

# ── deps: install from the lockfile (cached until a manifest changes) ────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/rag/package.json packages/rag/
COPY packages/runtime/package.json packages/runtime/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/telephony/package.json packages/telephony/
COPY packages/templates/package.json packages/templates/
COPY packages/tools/package.json packages/tools/
COPY packages/whatsapp/package.json packages/whatsapp/
# Optional extra CA certificate (corporate or build proxies): --secret id=ca,src=path/to/ca.pem
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export npm_config_cafile=/run/secrets/ca NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci

# ── build: compile every package and app ─────────────────────────────────────
FROM deps AS build
COPY . .
# The web app proxies /api/* here; Next.js fixes the target at build time
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN npx turbo run build

# ── prod: the same tree without development dependencies ────────────────────
FROM build AS prod
RUN npm prune --omit=dev \
 && rm -rf apps/web packages/*/src packages/*/test apps/*/src apps/*/test

# ── migrate ──────────────────────────────────────────────────────────────────
FROM build AS migrate
WORKDIR /repo/packages/db
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ── api ──────────────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production
COPY --from=prod /repo/package.json ./
COPY --from=prod /repo/node_modules ./node_modules
# Generated Prisma client (not a package, so prune leaves it out)
COPY --from=build /repo/node_modules/.prisma ./node_modules/.prisma
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/api ./apps/api
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
COPY --from=prod /repo/package.json ./
COPY --from=prod /repo/node_modules ./node_modules
COPY --from=build /repo/node_modules/.prisma ./node_modules/.prisma
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/worker ./apps/worker
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
WORKDIR /repo/apps/worker
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── web ──────────────────────────────────────────────────────────────────────
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Next.js standalone output: a minimal server with only the files it needs
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
