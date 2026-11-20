# syntax=docker/dockerfile:1
# Web: Next.js standalone server. Build context: repo root.
# The build runs on the build machine's own architecture: Next's native compiler segfaults under qemu when an ARM
# machine builds for linux/amd64. The output is plain JS (no next/image, so no native sharp), so the runtime stage
# below, which is the target platform, can use it as is.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shareinference/web..."
COPY apps/web apps/web
# The /docs pages render these files at build time.
COPY docs docs
# Next resolves rewrites at build time.
ARG API_INTERNAL_URL=http://localhost:4401
ENV NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm --filter @shareinference/web build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Standalone output keeps the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
# Not part of the standalone output: serves /share-worker.js.
COPY --from=build /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
