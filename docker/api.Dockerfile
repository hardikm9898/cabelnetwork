# API image: NestJS app + CLI (migrate, create-super-admin, run-jobs, verify-db).
# Build from the repository root:  docker build -f docker/api.Dockerfile -t cablenet-api .
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @cablenet/api...
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @cablenet/domain build \
 && pnpm --filter @cablenet/contracts build \
 && pnpm --filter @cablenet/api build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @cablenet/api...

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=Asia/Kolkata
WORKDIR /app
# Manifests + production node_modules (pnpm's symlinks into /app/node_modules/.pnpm stay valid).
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/db apps/api/db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/src/main.js"]
