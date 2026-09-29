# Deployment

This guide describes a self-hosted deployment. It does not publish an image, create an account, or deploy an application for you.

## Prerequisites

Provide:

- External PostgreSQL with a database and least-privilege runtime credentials. Production connections must use verified PostgreSQL TLS and `DB_CA_FILE` where the CA is not already trusted.
- An OIDC issuer reachable by the application over HTTPS, a client registered for the exact callback `<APP_URL>/auth/callback`, and a client secret stored outside the image.
- An HTTPS reverse proxy for the application origin. `APP_URL` is the public origin with no path; do not use a local Dex bypass in production.
- A pre-provisioned initial person or the configured `AUTH_BOOTSTRAP_EMAIL`. Bootstrap only the first matching authenticated identity; operators should pre-provision roles and verify the resulting admin account before normal use.

Current app roles are `admin`, `editor`, and `viewer`. Viewers can read and manage private stars; editors manage ordinary work; admins manage People and shared governance. The server remains authoritative for every request.

## Configuration

Pass configuration through a secret manager or a private environment file. Do not bake it into an image or commit it.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | Set `production`. |
| `APP_URL` | Yes | HTTPS origin, for example `https://goalie.example.com`; no path/query/fragment. |
| `DATABASE_URL` | Yes | External PostgreSQL URL. Use TLS verification in production. |
| `OIDC_ISSUER` | Yes | HTTPS OIDC issuer. |
| `OIDC_CLIENT_ID` | Yes | Registered OIDC client ID. |
| `OIDC_CLIENT_SECRET` | Yes | Secret for that client; keep out of images/logs. |
| `AUTH_BOOTSTRAP_EMAIL` | Optional | First-admin bootstrap email when pre-provisioning is not used. |
| `DB_CA_FILE` | Conditional | Mounted PostgreSQL CA bundle used for verified TLS. |
| `NODE_EXTRA_CA_CERTS` | Conditional | Mounted CA bundle for internal OIDC/provider certificates. |
| `MAX_REQUEST_BODY_BYTES` | Optional | Bounded request size; default is 2,000,000. |
| `OPENJEV_ENABLED` | Optional | `false` by default; enables draft/saved-work assistance only when explicitly configured. |
| `OPENJEV_BASE_URL` | Conditional | OpenJev HTTP(S) endpoint. Empty unless assistance is enabled. |
| `OPENJEV_TRUSTED_ORIGIN` | Conditional | Exact HTTPS origin trusted for OpenJev egress; required for remote HTTPS. |
| `OPENJEV_API_KEY_FILE` | Conditional | Mounted mode-0600 API-key file. |
| `OPENJEV_MODEL` | Optional | Model alias; default `openjev-latest`. |
| `OPENJEV_TIMEOUT_MS` | Optional | Provider timeout; default `30000`. |

An existing installation upgraded to a version with remote OpenJev assistance remains disabled unless `OPENJEV_ENABLED=true`, a base URL, a matching trusted origin, and a private key file are deliberately configured. The trusted origin must be a valid HTTPS origin with no userinfo, query, fragment, or non-root path. Legacy evaluation adapters retain their own `AI_*` configuration; those variables are not needed for current draft assistance.

Mount secrets read-only, for example `/run/secrets/postgres-ca.pem`, `/run/secrets/oidc-ca.pem`, and `/run/secrets/openjev-api-key`, and set the corresponding file variables. Never print their contents.

## Migrate, then start

The image contains the built web app and `build/migrate.mjs`; it has no automatic migration or seed entrypoint. Back up PostgreSQL and review the migration ledger before each upgrade. Run the bundled runner explicitly before starting the app:

Create the example network once with `docker network create goalie-net`, or use an existing operator-managed network that can reach PostgreSQL and OIDC. Mounted private key files must be readable by the image's `node` user (UID1000) while retaining private mode0600 permissions.

```sh
docker run --rm --network goalie-net --env-file ./goalie.production.env \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user node \
  -v "$PWD/secrets:/run/secrets:ro" \
  ghcr.io/<owner>/<repo>:<version> node build/migrate.mjs
```

Then run the same pinned image behind the reverse proxy. Bind a host-published port to loopback; let the proxy own the public HTTPS listener:

```sh
docker run -d --name goalie --network goalie-net \
  -p 127.0.0.1:4310:4310 \
  --env-file ./goalie.production.env \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user node \
  -v "$PWD/secrets:/run/secrets:ro" \
  ghcr.io/<owner>/<repo>:<version>
```

The image's default runtime user is non-root. Keep the read-only root filesystem, dropped capabilities, no-new-privileges, and noexec/nosuid/nodev `/tmp` unless an explicitly reviewed operational requirement says otherwise. Configure the reverse proxy to use HTTPS, preserve the exact `APP_URL`, and forward requests to loopback port 4310. `/health` is a readiness signal, not proof of OIDC login or latest-schema completeness; verify migrations and an authenticated smoke path separately.

## Images and rollback

The planned image names are parameterized:

```text
ghcr.io/<owner>/<repo>:<version>
<dockerhub-namespace>/goalie:<version>
```

No registry image has been published from this preparation. When publication is authorized, use only an immutable `X.Y.Z` version tag. There is no `latest`, branch, or major/minor alias. Configure Docker Hub with all-tag immutability. GHCR's application guard checks a target before writing, but cannot guarantee atomic immutability against an external writer; use no other publisher for these image names.

For either registry, publication first pulls the target and compares its image ID/config digest with the tested image. An identical target is skipped; a different target fails; and a push is allowed only after the registry explicitly reports the named manifest or image name is absent. Authentication or network-ambiguous results fail closed. The guard never overwrites or deletes a target.

Pin a release version rather than a mutable tag. The 7-day tested-image artifact supports rerunning a failed publication job. After it expires, recover the original image from a registry or other retained store, or publish a new version. Rebuilding may create a different image and conflict with an immutable tag; it cannot overwrite that tag. A version pin cannot reverse a migration: backups, schema-aware rollback planning, and operator ownership remain required. There is no automatic seed step or deployment after image publication.

## Trusted local MCP

MCP is a private stdio process, not an HTTP endpoint. Configure it only for a trusted operator with database access and an explicitly provisioned person:

```json
{
  "mcpServers": {
    "goalie": {
      "command": "node",
      "args": ["--env-file=/path/to/goalie.env", "--import", "tsx", "/path/to/goalie/scripts/mcp.ts"],
      "env": { "GOALIE_MCP_PERSON_ID": "provisioned-person-id" }
    }
  }
}
```

Keep the env file and database credentials private. The launcher re-reads the person and role from PostgreSQL; selecting an administrator is not implicit, and a client/tool annotation is not an authorization grant. A hosted MCP endpoint would need a separate OAuth/resource-authorization design and is not enabled here.
