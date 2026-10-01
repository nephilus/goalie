FROM dhi.io/bun:1.4.2-alpine3.23-dev@sha256:a89b9ee1afdaeeec46a581a6a68260758d453d43595df0209aa2ccfc953eb0fd AS tooling
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./

FROM tooling AS build
RUN bun install --frozen-lockfile
COPY app ./app
COPY public ./public
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY tsconfig.json vite.config.ts react-router.config.ts ./
RUN bun run build && bun build scripts/migrate.ts --target=bun --packages=external --outfile=build/migrate.mjs

FROM tooling AS production-dependencies
RUN bun install --frozen-lockfile --production --omit=peer

FROM dhi.io/bun:1.4.2-alpine3.23@sha256:eade039763b153d27382026f82563bdcc148970b6dda45993cbf34f096776b05 AS runtime
LABEL org.opencontainers.image.base.name="dhi.io/bun:1.4.2-alpine3.23" \
      org.opencontainers.image.base.digest="sha256:eade039763b153d27382026f82563bdcc148970b6dda45993cbf34f096776b05" \
      org.opencontainers.image.base.tooling="dhi.io/bun:1.4.2-alpine3.23-dev@sha256:a89b9ee1afdaeeec46a581a6a68260758d453d43595df0209aa2ccfc953eb0fd"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
COPY --from=production-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/build ./build
COPY --chown=65532:65532 package.json bunfig.toml LICENSE ./
COPY --chown=65532:65532 migrations ./migrations
USER 65532:65532
EXPOSE 4310
ENTRYPOINT []
CMD ["/usr/local/bin/bun", "--no-env-file", "node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]
