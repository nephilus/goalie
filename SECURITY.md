# Security policy

## Supported versions

The latest public release is the supported version. Until the first public release exists, this repository is preparation material and no hosted service or release-support SLA is claimed.

## Reporting a vulnerability

Do not post secrets, credentials, private data, or exploit-sensitive details in a public issue. After the repository owner enables GitHub's private vulnerability reporting, use the repository Security tab to submit a report. This project does not publish an invented security email address or response-time promise.

If private vulnerability reporting is not enabled, contact the repository owner through an already-established private channel rather than disclosing sensitive details publicly. Include the affected version/commit, impact, reproduction conditions, and a minimal safe reproduction when it is appropriate to share.

## Security model

- OIDC authenticates web users; Goalie rechecks the current PostgreSQL role (`admin`, `editor`, or `viewer`) for authorization.
- Web mutations require authenticated sessions and same-origin/CSRF checks. Shared writes use transactions and expected workspace revisions; stale or unauthorized writes fail closed.
- The local stdio MCP launcher requires an explicit `GOALIE_MCP_PERSON_ID` and database access. It has no network listener, is a trusted operator boundary, and must not be given to untrusted clients.
- Optional Goalie Suggestions and saved-work decisions are disabled by default. When enabled, provider egress requires an explicit trusted origin, bounded requests/responses, timeouts, redirect rejection, and a private API-key file. The provider is not an authorization mechanism and suggestions never save automatically.
- Production requires HTTPS application/OIDC origins and verified PostgreSQL TLS. Operators should use the non-root, read-only, capability-dropped container profile documented in [deployment](docs/deployment.md).

Report suspected secret exposure privately. A `.gitignore` rule does not remove material from history; owners must audit and rotate any confirmed exposed credential before publication.
