# Office website (static) served by Caddy, which also terminates TLS and proxies /api to the API.
# Build from the repository root:  docker build -f docker/web.Dockerfile -t cablenet-web .
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @cablenet/admin...
COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY apps/admin apps/admin
RUN pnpm --filter @cablenet/admin exec vite build \
 && find apps/admin/dist -name '*.map' -delete

FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/admin/dist /srv/admin
