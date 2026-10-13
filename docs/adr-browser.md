# ADR browser API

The browser uses the same ADR service and schemas as the local MCP tools. Requests require an authenticated OIDC session. Mutations also require the existing same-origin and CSRF checks. The server derives the actor from the session, not the request body.

All responses use `Cache-Control: no-store`. Successful responses wrap the service result as `{ "data": ..., "user": ..., "csrfToken": ... }`. Errors use the work API's `{ "error": ..., "code": ... }` format, with field details for schema failures.

## Reads

| Method and path | Query parameters | `data` |
| --- | --- | --- |
| `GET /api/work/adrs` | `limit`, `cursor`, `search`, `personId`, `name`, `role`, `status`, `itemId` | `{ revision, items, nextCursor }` |
| `GET /api/work/adrs/:id` | None | `{ revision, adr }` |
| `GET /api/work/adrs/:id/history` | `limit`, `cursor` | `{ revision, items, nextCursor }` |
| `GET /api/work/notifications` | `limit`, `cursor`, `unreadOnly` | `{ revision, items, nextCursor }` |

Unknown or repeated parameters are rejected. `limit` defaults to 25 and must be an integer from 1 to 100. `cursor` is the opaque string returned in `nextCursor`; stop when that value is null. `unreadOnly` accepts exactly `true` or `false`.

ADR search includes the seven decision fields and the optional document URL. Status is `draft`, `pending`, `approved`, or `changes_requested`. A `personId` or `name` filter matches requester or approver unless `role=requester` or `role=approver` is supplied. Different filters intersect. Account IDs distinguish people with the same display name. Plain-name matches do not establish identity.

Notifications are restricted to the signed-in recipient. There is no recipient override, including for administrators.

## Mutations

`POST /api/work/adrs` accepts the existing `adrCommandRequestSchema`:

```json
{
  "expectedRevision": 42,
  "command": {
    "type": "adr.submit",
    "id": "adr-id-from-a-read"
  }
}
```

The command types are `adr.create`, `adr.update`, `adr.submit`, `adr.approve`, `adr.request_changes`, and `adr.record_approval`. Their fields and approval rules are shared with the [MCP contract](mcp.md) and [ADR specification](adr-spec.md). Successful writes return `{ revision, adr }` inside `data`.

Use the top-level workspace revision from a read, not the ADR's last-modified revision. A stale write fails without applying changes. Preserve the draft, read the current record, and let the user review it before retrying. Do not silently resubmit with a newer revision.

`POST /api/work/notifications/read` accepts exactly `{ "id": "notification-id", "read": true }`, or `false` to mark it unread. It returns the notification inside `data`. This private preference does not advance the shared workspace revision.

Both POST endpoints reject query parameters. Send JSON with `Content-Type: application/json` and the session's `X-CSRF-Token` header. Existing request-size limits apply. The route cannot confer approval rights: only the nominated eligible account can give verified approval, while plain-name approval must be explicitly recorded by an editor or admin.

Timeline mentions continue to use `/api/work` with `update.add` or `update.edit` and `mentionedPersonIds`. They are not parsed from arbitrary `@name` text. See the [ADR specification](adr-spec.md) for notification deduplication and invalidation behavior.

## Deployment and testing

Apply migrations `0012` and `0013` before serving this source. The HTTP routes do not run migrations or seed data. Build into a new ignored directory and verify the candidate before replacing a served build. See [development](development.md) and [deployment](deployment.md).

HTTP integration tests must use synthetic sessions and a disposable database. Include unauthenticated requests, CSRF/origin failures, viewer writes, nominated approval, stale revisions, strict query parsing, oversized bodies, private notification reads, and compatibility with existing work operations. Browser acceptance separately checks form behavior, source navigation, focus, responsive layout, and unsaved-change protection.
