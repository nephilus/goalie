# Contributing to Goalie

Thanks for helping improve Goalie. Read [AGENTS.md](AGENTS.md), [DESIGN.md](DESIGN.md), and [PRODUCT.md](PRODUCT.md) before changing application behavior.

## Isolated setup

Use Node.js 24.14 or newer and Bun 1.4.2. Install with the lockfile, then create a fresh ignored instance directory; do not use a shared `.env` or existing runtime data.

```sh
bun install --frozen-lockfile
bun run local:setup --instance-dir .local/contrib --variant blank \
  --app-url http://127.0.0.1:4310 \
  --dex-issuer http://127.0.0.1:5558/dex \
  --listen-port 5558 --database-port 54329
bun run db:start -- --instance-dir .local/contrib
```

Start the pinned Dex image, run migrations, and use `seed-work.ts` only when synthetic demo records are useful. Use unused loopback ports for parallel instances. `--env-file` does not override inherited variables; unset inherited `DATABASE_URL`, `APP_URL`, `NODE_ENV`, OIDC, AI, and OpenJev variables before commands that load a separate instance.

For application changes, run the relevant typecheck, tests, and build in that isolated environment. The complete local commands are documented in [development](docs/development.md). Do not use real credentials, production data, private backups, or private runtime directories in tests, screenshots, fixtures, or commits.

## Changes and pull requests

Use Conventional Commit subjects and PR titles:

```text
fix(work): preserve manual workstream selection
feat(api)!: change the work command contract
```

Keep a change focused, explain user-visible behavior and authorization implications, and include tests for meaningful boundary or transition behavior. Describe migrations and operator steps when applicable. Do not add source-string tests for prose or wire-through copies.

A maintainer reviews the PR, verifies the required CI job, and squash-merges using the Conventional Commit PR title. Failed CI must be fixed rather than bypassed. Release Please uses the resulting commit history to open one release PR; maintainers review and merge that PR before a tag/release is created.

## Release and security boundaries

Contributors must not publish source or images, change repository visibility, configure release credentials, deploy an app, or add real credentials/data without explicit owner authorization. See [docs/releases.md](docs/releases.md) for the owner-only first-publication checklist and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
