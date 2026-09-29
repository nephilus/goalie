FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS tooling
RUN npm install --global bun@1.4.2
WORKDIR /app
COPY package.json bun.lock ./

FROM tooling AS build
RUN bun install --frozen-lockfile
COPY app ./app
COPY public ./public
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY tsconfig.json vite.config.ts react-router.config.ts ./
RUN bun run build && bun build scripts/migrate.ts --target=node --packages=external --outfile=build/migrate.mjs

FROM tooling AS production-dependencies
RUN bun install --frozen-lockfile --production

FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 4310
CMD ["node", "node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]
