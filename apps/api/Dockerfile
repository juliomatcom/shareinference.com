# syntax=docker/dockerfile:1
# api image. Build context: repo root.
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY libs/logger-ts/package.json libs/logger-ts/

# TypeScript compiles on the build machine's own architecture (fast, no qemu); only the production dependencies, which
# may include native modules, are installed for the target platform (the `prod` stage).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY libs/logger-ts/package.json libs/logger-ts/
# `@shareinference/api...`: the api and the workspace libraries it depends on.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shareinference/api..."
COPY libs/logger-ts/tsconfig.json libs/logger-ts/tsconfig.build.json libs/logger-ts/
COPY libs/logger-ts/src libs/logger-ts/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm --filter @shareinference/logger build && pnpm --filter @shareinference/api build

FROM deps AS prod
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@shareinference/api..."

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod /app/node_modules node_modules
COPY --from=prod /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
# apps/api/node_modules/@shareinference/logger links here.
COPY --from=build /app/libs/logger-ts/package.json libs/logger-ts/
COPY --from=build /app/libs/logger-ts/dist libs/logger-ts/dist
COPY apps/api/package.json apps/api/
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
