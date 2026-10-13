# MCP reference

Goalie MCP is a private stdio child process. It is not an HTTP endpoint and has no `/mcp` URL. The client launches `scripts/mcp.ts`, initializes the protocol, discovers tools, and sends JSON-RPC on stdin/stdout. See [deployment](deployment.md#trusted-local-mcp) for configuration and [development](development.md#mcp-development) for a synthetic local instance.

## Setup and trust

Use Node 24.14+ and the repository's installed dependencies. Supply the intended instance environment and an explicit, already provisioned `GOALIE_MCP_PERSON_ID`. Use a clean inherited environment so an unrelated `DATABASE_URL` cannot select the wrong workspace. Never print or commit environment files or principal configuration.

```sh
env -i PATH="$PATH" HOME="$HOME" GOALIE_MCP_PERSON_ID=demo-editor \
  node --env-file=.local/dev/.env --import tsx scripts/mcp.ts
```

This example assumes the isolated instance and synthetic person already exist. The launcher does not migrate, seed, create accounts, or select an administrator by default. Apply migrations explicitly to the intended instance first. Updated source requires `0012_adrs.sql` and `0013_update_mentions.sql`; a previously deployed app build does not imply that its database has these migrations. Do not migrate live data merely to smoke-test the connection.

Call `identity({})` first. It returns the current principal and workspace revision. The server rechecks current roles; tool availability and annotations do not authorize mutations. The process has direct database access, so this is a trusted operator boundary, not delegated OAuth or browser-session authentication.

For an ADR, verified approval means the configured principal is the nominated approver and currently has editor/admin permissions. It is not proof of a separate human browser action. Do not change the configured principal to impersonate an approver. Admin access does not grant permission to approve for a different nominated account.

## Common conventions

- Inspect `tools/list` before calling unfamiliar operations. Input objects are strict: unknown properties fail validation.
- Prefer `structuredContent` on success; the same result is provided as JSON text. Check `isError` as well as transport errors. Service errors contain `{ "error": { "status": 409, "code": "revision_conflict", "message": "..." } }` in text content. Protocol schema validation can fail before the service handler runs.
- Shared writes require `expectedRevision` from a fresh read. On conflict, reread and review the intended change. Never blindly replay with a new revision.
- Use the **top-level workspace revision**, not `adr.revision`. An ADR's revision is the workspace revision when that ADR last changed; unrelated work can advance the workspace afterward.
- Lists accept `limit` (1–100, default 25) and optional opaque `cursor`, and return `nextCursor` or null. Pass returned cursors unchanged with the same filters. Pages are individually consistent, not a pinned multi-page snapshot. If the workspace revision changes during traversal, restart when completeness matters. Private inbox changes can also shift notification pages without changing the workspace revision.
- Existing catalogue tools return `values`. Work/ADR/history/notification lists return `items`.
- Account-private `set_work_star` and `set_notification_read` are explicit idempotent writes that do not advance the shared revision. No recipient override is accepted for private notification operations.

## Existing work tools

| Tools | Contract |
| --- | --- |
| `identity` | `{}` → `{revision, person}` |
| `list_goals`, `list_workstreams`, `list_people`, `list_tags` | Bounded catalogue pages |
| `list_work` | `query`, `status`, `workstreamId`, `goalId`, `assigneeId`, `tagId`, `starredOnly`, pagination. Query searches title/description. |
| `get_work` | `itemId`, optional `updatesLimit` (1–100, default 50). Returns item, direct children, typed updates, star state, and truncation flags. |
| `create_goal`, `create_workstream`, `create_work`, `create_tag`, `create_person` | `expectedRevision` plus the entity input (`goal`, `workstream`, `item`, `tag`, `person`). Person provisioning is admin-only. |
| `update_goal`, `update_workstream`, `update_work`, `update_tag`, `update_person` | `expectedRevision`, `id`, and the full entity input. Read first and preserve fields. Person email is immutable. |
| `delete_goal`, `delete_workstream`, `delete_work`, `delete_tag`, `delete_person` | `expectedRevision`, `id`. Existing ownership, hierarchy, governance and reference rules apply. ADRs now also block deletion of their owning work item and referenced people. |
| `add_work_update` | `expectedRevision`, `itemId`, `kind`, `body`, optional `mentionedPersonIds` |
| `edit_work_update` | `expectedRevision`, `id`, `body`, optional `mentionedPersonIds`. Update author/admin only, preserving kind and original attribution. |
| `delete_work_update` | `expectedRevision`, `id`. Update author/admin only; associated mention notifications are removed. |
| `set_work_star` | `itemId`, `starred`, for the configured account only |
| `suggest_work_fields`, `suggest_workstream_goals` | Read-only suggestions for unsaved drafts. Provider access is optional; suggestions never authorize saving. |

Work-update `kind` is `note`, `blocker`, or `blocker_resolved`. Body is nonempty and at most 10,000 characters; blocker bodies are limited to 4,000. A blocker sets current blocker text, blocker resolution clears it, and a note leaves it unchanged. Editing/deleting blocker history recomputes the current blocker as appropriate.

`mentionedPersonIds` contains up to 100 distinct existing person IDs. Omission on create means no mentions. Omission on edit preserves existing mentions, while `[]` clears them. Only newly added recipients receive notifications, excluding the acting account. Text such as `@Jane` alone does not notify anyone. The browser mention picker resolves selections to IDs. Returned work updates include the persisted mention IDs. These commands use the existing shared web service as well as MCP, with existing authorization unchanged.

## ADR input

The seven content fields are `context`, `concern`, `decision`, `alternatives`, `consequences`, `downsides`, and `rationale`. Each is trimmed, nonempty, and at most 20,000 characters. `documentUrl` is optional/null, at most 2,048 characters, and must use HTTP(S). The server never fetches it.

Identity objects are exactly one of:

```json
{ "kind": "person", "personId": "existing-person-id" }
```

```json
{ "kind": "name", "name": "External reviewer" }
```

There is one `requester` and one `approver`. Requester defaults to the configured creator on create; replacement updates require it explicitly. Approver is required. An existing-person approver must be an editor/admin. A normalized plain-name approver matching an existing person's name is rejected; choose the correct person ID instead. Namesakes or aliases are not verified identities.

`mentionedPersonIds` on an ADR is a distinct existing-person list, maximum 100. It defaults to `[]`. Unlike partial timeline-update edits, `update_adr` is a full replacement: preserve mention IDs and the document URL explicitly, or they are cleared. The task owner and creator cannot be replaced.

## ADR tools

| Tool | Input | Result / behavior |
| --- | --- | --- |
| `list_adrs` | Optional `search`, `itemId`, `status`, `personId`, `name`, `role`, `cursor`, `limit` | `{revision, items, nextCursor}`. Newest modified first with stable ID tie-break. |
| `get_adr` | `id` | `{revision, adr}`. Current record, creator, identities, approval and timestamps. |
| `list_adr_history` | `adrId`, optional `cursor`, `limit` | `{revision, items, nextCursor}`. Newest revision first, full snapshots and actor attribution. |
| `create_adr` | `expectedRevision`, `adr` (seven fields, `itemId`, approver, optional requester/document/mentions) | `{revision, adr}`. Creates Draft; does not submit or approve. |
| `update_adr` | `expectedRevision`, `id`, full editable `adr` | `{revision, adr}`. Changed decision content or identities resets review to Draft; prior history remains. |
| `submit_adr` | `expectedRevision`, `id` | Draft/Changes requested → Pending. Notifies the nominated account, if any and not self. |
| `approve_adr` | `expectedRevision`, `id` | Pending → Approved, only as the nominated existing-person approver. `approval.mode` is `verified`. |
| `request_adr_changes` | `expectedRevision`, `id`, nonempty `comment` (≤10,000 characters) | Pending → Changes requested, only as the nominated existing-person approver. |
| `record_adr_approval` | `expectedRevision`, `id`, optional `comment` (≤10,000 characters) | Pending → Approved for plain-name approvers only. Any editor/admin may record; `approval.mode` is `recorded`. |

`status` values are `draft`, `pending`, `approved`, `changes_requested`. `search` matches all seven fields and document URL, case-insensitively, as literal text. `personId` matches existing-person requester or approver IDs. `name` matches plain names or current account names case-insensitively. `role` narrows identity matching to `requester` or `approver`; omit it to match either. Different filters intersect. Name filtering is not an identity assertion.

There is no ADR delete tool, general status setter, history editor, approver impersonation parameter, or automatic approval. Content/identity changes after approval clear current approval and require explicit resubmission. Mention-only edits do not invalidate approval. Old approval details remain in attributed history.

Every mutation also revalidates the current nominee's role. If a nominated person becomes a viewer, they cannot approve, and even a mention-only edit fails until an authorized editor/admin replaces the nominee with an eligible person. Changing the nominee returns the ADR to Draft; submit it again to request review. A previously delivered approval notification can remain visible until that reassignment, but it grants no permission. Prior approval history is not rewritten by later role changes.

History is append-only through the service and MCP, not cryptographically tamperproof against a database owner. Historical person references are retained in a relational foreign-key table so an older application writer cannot delete a person merely because their identity has been removed from the current ADR.

### Example: create, review, approve

All IDs below are placeholders. Read actual IDs and a fresh revision before each authorized write.

```json
{
  "expectedRevision": 12,
  "adr": {
    "itemId": "existing-task-id",
    "context": "The team records decisions beside implementation work",
    "concern": "Decisions are otherwise scattered across documents",
    "decision": "Keep structured ADRs attached to tasks",
    "alternatives": "A separate unlinked document directory",
    "consequences": "Searchable decisions with accountable review",
    "downsides": "A small amount of structured entry",
    "rationale": "Task ownership keeps decisions discoverable",
    "approver": { "kind": "person", "personId": "existing-editor-id" },
    "documentUrl": null,
    "mentionedPersonIds": []
  }
}
```

1. Call `identity`, then `list_work`/`get_work` and `list_people` to verify the target and eligible approver.
2. With explicit authorization, call `create_adr` using the input above and actual current values. Save the returned `adr.id`.
3. Read `get_adr`, review, and call `submit_adr` with its top-level revision.
4. The nominated person, through their already approved principal connection, reads `list_notifications` and `get_adr`, then explicitly calls `approve_adr` or `request_adr_changes`.
5. Read `list_adr_history` to inspect who created, submitted and responded. Follow `nextCursor` until null if a complete audit is needed.

For an external plain-name approver, steps 1–3 are the same but no account notification is possible. An authorized editor/admin explicitly calls `record_adr_approval` after submission. Optional evidence can be placed in `comment`; actor and timestamp attribution do not depend on providing text.

## Notification tools

| Tool | Input | Result |
| --- | --- | --- |
| `list_notifications` | Optional `unreadOnly`, `cursor`, `limit` | `{revision, items, nextCursor}` for the configured account only, newest first. Invalidated events are excluded. |
| `set_notification_read` | `id`, `read` boolean | `{notification}` for an existing, non-invalidated notification belonging to the configured account. |

Kinds are `approval_requested`, `approval_result`, and `mention`. Events contain `actorId`, `recipientId`, `itemId`, and exactly one of `adrId`/`updateId`, plus timestamps. These are source references, not standalone URLs. The browser inbox uses them to open the ADR overlay or the owning task's timeline entry.

Approval results notify an existing-person requester unless they performed the action themselves. If the requester is a plain name, there is no account inbox for that identity. Mentions and approval requests suppress self-notifications. Removing mentions or ending/changing a pending review invalidates obsolete notifications. Re-adding a removed mention creates a new event. Deleting a timeline post removes its notifications. Reading or marking an event never approves the ADR.

## Errors and recovery

- `revision_conflict`: read fresh data, review the intended change, and ask for authorization again if its meaning changed.
- `forbidden`: the current actor lacks permission, is not the nominated approver, or is trying to record approval for an account. Do not change principal or role as a workaround.
- `invalid_reference`: owner/person missing, viewer nominated, or plain-name approver matches an existing account. Correct the reviewed input rather than provisioning implicitly.
- `invalid_transition`: the current ADR state does not allow the requested action. Read the record before choosing a valid transition.
- `not_found`: record absent, or notification absent/not owned/invalidated. Private notification errors do not distinguish another person's records.
- `entity_in_use`: work/person deletion would break references or retained audit history.
- Missing tables after source upgrade: an operator must review and run migrations on the intended instance. Connection checks must not mutate the database.

Tool schemas, implementation, and tests are authoritative: `app/shared/adr.ts`, `app/server/adr.server.ts`, `app/shared/work.ts`, `app/server/work.server.ts`, `app/mcp/server.ts`, and `tests/adr*.test.ts`. Browser behavior is recorded in [the feature specification](adr-spec.md); its session-authenticated transport is documented in [the browser API](adr-browser.md).
