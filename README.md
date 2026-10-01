# Goalie

Goalie is a self-hosted team-work application for organizing ordinary work across persistent workstreams. People use the web UI; trusted local agents can use the stdio Model Context Protocol (MCP) server. Both adapters call the same revision-checked, authorized application operations.

## What it supports

- Goals linked to one or more workstreams.
- Work items with a home workstream, required status, optional assignees, due dates, blockers, one-level subtasks, tags, and typed updates.
- All work and My work views with search, status/tag/workstream/goal/assignee filters, and private per-account stars.
- Admin-only editing of existing People records. Names and roles are editable; email is immutable. There is no People add/delete UI.
- Optional Goalie Suggestions for unsaved work and workstream drafts, plus scoped saved-work assessments. The bottom-left **AI assistance** switch controls all of these UI features together, defaults off, and remembers your choice for your account in this browser. **Debug mode** sits alongside it. Suggestions never save automatically or assign people; manual work remains usable with AI off or unavailable.
- A local stdio MCP server for explicitly provisioned principals. It is not a hosted MCP endpoint.

The current UI serves `/`, `/api/work`, `/api/work/assist`, `/api/work/assist/workstream`, `/api/work/assessments`, `/api/work/assessments/preference`, `/api/work/assessments/scope`, `/auth/*`, and `/health`. Legacy database tables and evaluation adapters remain for compatibility; they are not part of the current work UI.

## Quick start

Prerequisites are Node.js 24.14 or newer, Bun 1.4.2, Podman, and the pinned `pg0` utility. See [development](docs/development.md) for installation, isolated setup, Dex, migrations, tests, and clean-environment commands.

```sh
bun install --frozen-lockfile
bun run local:setup --instance-dir .local/dev --variant demo \
  --app-url http://127.0.0.1:4310 \
  --dex-issuer http://127.0.0.1:5558/dex \
  --listen-port 5558 --database-port 54329
bun run db:start -- --instance-dir .local/dev
```

The setup command creates private, ignored instance files and does not print passwords. Start the pinned Dex container, run migrations, optionally seed synthetic records, and start the app as described in [development](docs/development.md). Choose unused loopback ports for parallel instances. Never publish local development servers or their credentials.

## Architecture and operations

- [Design and UI behavior](DESIGN.md)
- [Product brief](PRODUCT.md)
- [Development setup](docs/development.md)
- [Deployment](docs/deployment.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Release and first-publication checklist](docs/releases.md)
- [Changelog](CHANGELOG.md)

The candidate container uses digest-pinned Docker Hardened Images Bun Alpine and UID/GID65532; Node remains development/test tooling only. Production operators must run migrations explicitly before startup; the image has no automatic migration or seed entrypoint. The application-only [Helm chart](charts/goalie) uses external PostgreSQL and OIDC. Authenticated image build, vulnerability scan and same-image Kubernetes acceptance are required before deployment; source/chart validation alone is not production qualification. See [deployment](docs/deployment.md).

When publication is authorized, use only `X.Y.Z` version tags for both registries; there is no `latest`, branch, or major/minor alias. The publication guard never overwrites or deletes an existing target: it skips an identical image, rejects a different image, and publishes only after the registry explicitly confirms that the target manifest is absent. Keep a single publisher for each image name. A registry authentication or network-ambiguous result fails closed.

## Stack and license

TypeScript, React, React Router, Node.js, PostgreSQL, Tailwind CSS, and shadcn/Radix UI primitives. OIDC is the web identity boundary. The local MCP launcher uses an explicitly provisioned Goalie person and rechecks that person's current database role on every operation. The repository is MIT licensed; see [LICENSE](LICENSE). `package.json` remains private: source/container publication is not npm package publication.

## Scope and trust boundaries

Goalie is work tracking, not an autonomous coordination system, portfolio suite, issue tracker replacement, or hosted public service. Suggestions are optional assistance, not authorization or persistence. Web writes require an authenticated OIDC session plus origin/CSRF checks. Shared writes are authorized and revision-checked inside transactions. A local MCP process has database access and must be treated as a trusted operator boundary; do not give its credentials to untrusted clients.

No public hosted instance, registry image, release, or production security certification is claimed by this repository preparation. Source publication and image publication require the owner setup and approvals in [docs/releases.md](docs/releases.md).
