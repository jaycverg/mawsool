# syntax=docker/dockerfile:1
#
# Production images for the four apps, one target each:  api  person  clinician  ops
#
#   docker build --target api       -t mawsool-api       --build-arg NEXT_PUBLIC_API_URL=https://api.example.test .
#   docker build --target person    -t mawsool-person    --build-arg NEXT_PUBLIC_API_URL=https://api.example.test [--build-arg NEXT_PUBLIC_PUBLIC_DEMO=true] .
#   docker build --target clinician -t mawsool-clinician --build-arg NEXT_PUBLIC_API_URL=https://api.example.test .
#   docker build --target ops       -t mawsool-ops       --build-arg NEXT_PUBLIC_API_URL=https://api.example.test .
#
# All four share one `build` stage (one `pnpm install` and one `pnpm build` of the whole workspace), so building the other
# targets after the first reuses its layers. The API address is fixed at build time: the person app bakes it into its
# static files, and the two staff apps put it in their page policy. `NEXT_PUBLIC_PUBLIC_DEMO=true` is read only by the
# person app (the hosted demo: no dialling from the crisis screen); leave it out for any other build.

ARG NODE_IMAGE=node:24.11.1-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine

# --- base: Node, pnpm, a non-root user ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
# The version `packageManager` pins. Installed with npm, not corepack: the corepack that ships with this Node (0.34) prepares
# pnpm 12 without its entry file, so `pnpm` fails with MODULE_NOT_FOUND.
RUN npm install --global pnpm@12.6.0 && pnpm --version
USER node
WORKDIR /app

# --- build: install and build everything ------------------------------------------------------------------------------
FROM base AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PUBLIC_DEMO=""
# An empty address would be baked in as an empty string (the apps only fall back to localhost when it is unset), so refuse it.
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "build argument NEXT_PUBLIC_API_URL is required" >&2; exit 1; }
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_PUBLIC_DEMO=${NEXT_PUBLIC_PUBLIC_DEMO}
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- api: the workspace with node_modules; applies migrations, then serves ---------------------------------------------
# `db:migrate` runs through tsx, a dev dependency that stays in the image on purpose.
FROM base AS api
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000
COPY --from=build /app /app
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @mawsool/api db:migrate && exec node apps/api/dist/main.js"]

# --- person: the static export behind Caddy ---------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS person
COPY infra/Caddyfile.person /etc/caddy/Caddyfile
COPY --from=build /app/apps/person/out /srv
EXPOSE 80

# --- clinician and ops: Next in production mode ----------------------------------------------------------------------
FROM base AS clinician
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/clinician
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

FROM base AS ops
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/ops
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
