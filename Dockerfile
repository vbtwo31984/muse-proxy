# muse-proxy app image. Runs TypeScript directly (Node 24 type stripping); only the
# Muse Helper is bundled, so the server can serve it signed at /v1/helper/latest.

FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build-helper.ts

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production \
    MP_DATA_DIR=/var/lib/muse-proxy \
    MP_HELPER_BUNDLE=/app/dist/muse-helper.mjs \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY --from=build /app/dist ./dist
RUN printf '#!/bin/sh\nexec node /app/src/server/cli.ts "$@"\n' > /usr/local/bin/muse-proxy \
 && chmod 755 /usr/local/bin/muse-proxy \
 && mkdir -p /var/lib/muse-proxy && chown node:node /var/lib/muse-proxy
USER node
EXPOSE 8080 2525
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server/main.ts"]
