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

Create the example network once with `docker network create goalie-net`, or use an existing operator-managed network that can reach PostgreSQL and OIDC. Mounted private key files must be readable by runtime UID/GID65532 while retaining private mode0600 permissions. The candidate Bun Alpine image must pass authenticated DHI build and runtime qualification before deployment; source changes alone do not establish compatibility.

The production dependency stage uses `bun install --frozen-lockfile --production
--omit=peer`. Required runtime peers such as React are explicit application
dependencies. Peer-only tooling is excluded: React Router's optional TypeScript
peer otherwise brings the native compiler into the runtime image despite being
a development dependency. The build stage retains the complete dependency set.

```sh
docker run --rm --network goalie-net --env-file ./goalie.production.env \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user 65532:65532 \
  -v "$PWD/secrets:/run/secrets:ro" \
  ghcr.io/<owner>/<repo>:<version> /usr/local/bin/bun --no-env-file build/migrate.mjs
```

Then run the same pinned image behind the reverse proxy. Bind a host-published port to loopback; let the proxy own the public HTTPS listener:

```sh
docker run -d --name goalie --network goalie-net \
  -p 127.0.0.1:4310:4310 \
  --env-file ./goalie.production.env \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user 65532:65532 \
  -v "$PWD/secrets:/run/secrets:ro" \
  ghcr.io/<owner>/<repo>:<version>
```

The image's default runtime user is non-root. Keep the read-only root filesystem, dropped capabilities, no-new-privileges, and noexec/nosuid/nodev `/tmp` when mounted. Configure the reverse proxy to use HTTPS, preserve the exact `APP_URL`, and forward requests to loopback port 4310. GET `/health` requires every bundled migration version/checksum and the initialized current workspace; extra future migration entries are allowed. It returns503 on database/schema failure without repairing anything. GET `/livez` returns200 without database, OIDC or AI access. Use `/livez` for startup/liveness and `/health` for readiness; provider/database outages must not cause liveness restarts. Neither endpoint proves OIDC login; verify an authenticated smoke path separately.

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

## Kubernetes chart

`charts/goalie` owns only the application. Supply PostgreSQL, OIDC, referenced Secrets,
registry pull credentials, and TLS termination before installation. No subcharts,
database/operator, identity service, certificate controller, or metrics stack is installed.

Use an internal immutable image digest and a private values file containing references,
not secret values:

```yaml
image:
  repository: registry.internal.example/goalie
  digest: sha256:<qualified-destination-manifest-digest>
app:
  url: https://goalie.internal.example
oidc:
  issuer: https://gitlab.internal.example
  clientId: goalie
  clientSecretRef: {name: goalie-oidc, key: client-secret}
database:
  urlSecretRef: {name: goalie-db-app, key: uri}
  caSecretRef: {name: goalie-db-ca, key: ca.crt}
trust:
  caSecretRef: {name: internal-ca, key: ca.crt}
```

For EDB CloudNativePG use the read-write Service and same-namespace application
Secret (`uri` or `fqdn-uri`), not a pod IP, read-only endpoint or superuser.
The URL must have no `sslmode` or `sslmode=verify-full`; its hostname must match
the certificate. Actual GitLab claims and EDB versions require target qualification.

After database backup and migration review:

```sh
helm upgrade --install goalie ./goalie-<version>.tgz \
  --namespace goalie --values ./goalie-values.yaml --wait --timeout 10m
helm test goalie --namespace goalie --logs
```

`image.repository` is a lowercase repository name, optionally including a registry
and port (for example `registry.internal.example:5000/team/goalie`), without a URL
scheme, tag, digest, or whitespace. Supply the pin separately in `image.digest`;
local-only tags use `image.tag` with `image.pullPolicy: Never`.

The same-image pre-install/pre-upgrade migration hook runs before rollout.
External Secrets must already exist. An optional `migration.urlSecretRef` supplies
a distinct migration owner. Failed hooks retain Job diagnostics for up to one day;
the next attempt replaces the prior hook. Disabling migrations requires an externally
prepared schema. No seed/startup migration or database rollback is provided.
Workload rollback requires schema compatibility; Helm rollback cannot undo SQL.

Default replicas are one. Requests100m/128Mi and limits1000m/512Mi are initial
tunable values, not capacity claims. PDB requires at least two replicas.
AI deduplication is process-local; multiple pods do not guarantee exactly-once inference.
Optional Ingress requires an existing controller/TLS Secret and a host matching
`app.url`. Optional NetworkPolicy uses exactly the supplied ingress/egress arrays;
empty arrays deny all. CNI enforcement, DNS/provider/DB rules, and namespace policy
covering migration hooks remain platform responsibilities.

AI is off by default. Enabling `openjev` requires a trusted HTTPS provider origin
and existing key Secret. A same-image nonroot init container copies its projected
0440 source into a size-limited memory volume as UID65532/mode0600. The app mounts
only that destination read-only. No root helper or relaxed private-key check is used.
After key rotation, change `podAnnotations` to trigger an explicit rollout.
The key-only volume is not a portable noexec guarantee.

For secret-free chart validation run `node scripts/check-chart.mjs` with Helm4.3.0
on PATH (or `HELM=/path/to/helm`). This checks rendering and rejected configurations,
not cluster, ingress-controller, or CNI behavior. Local preloading alone may use
an explicit image tag with `pullPolicy: Never` and empty digest.

## Image vulnerability gate

Outside the air gap, scan the exact built image with Trivy0.74.0:

```sh
CONTAINER_ENGINE=podman EXPECTED_REVISION=<source-sha> \
  node scripts/scan-image.mjs <image> .local/image-report
```

Put the pinned `trivy` binary on PATH or set `TRIVY_BIN` to its explicit path.
The scanner does not search private development-instance directories.

The gate fails for HIGH/CRITICAL findings with an available fixed version.
Unfixed HIGH/CRITICAL findings remain prominently reported but do not block by
policy. The report must contain Alpine OS packages and JavaScript runtime-library
inventory; empty/unsupported scans, identity mismatches, stale/missing vulnerability
data and scanner errors fail closed. Base-image branding is not a CVE result.
The scanner exports an immutable Docker-format archive, verifies its config ID,
and produces `trivy-report.json`, `sbom.cdx.json`, `image-identity.json`,
`db-metadata.json` and `summary.json`. Error runs retain available diagnostics.
Both engines are supported: Docker's `save` already emits Docker format; only
Podman receives `--format docker-archive`.
No ignore file, automatic VEX suppression or waiver override is used.

Pins do not update themselves. An operator must resolve patched Bun1.4/Alpine3.23
dev/runtime digests together, inspect their architecture/runtime metadata, update
Dockerfile FROM pins and base-identity labels, and repeat application, image,
scan and Kubernetes qualification. If the Bun patch changes, align the package
manager/devcontainer/CI pins and smoke expectations. Application-library fixes
require a reviewed dependency/lock change; changing the OS label does not fix them.
Do not overwrite released tags, auto-merge updates or deploy from a scheduled scan.
Actual image size and CVE counts are available only after successful image scanning.
