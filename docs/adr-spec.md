# ADRs, approvals, notifications, and work controls

This specification records the agreed product behavior across the shared service, MCP tools, and browser UI. See the [MCP reference](mcp.md), [browser API](adr-browser.md), and [development guide](development.md). This document is not permission to mutate a workspace or deploy.

## Delivery boundaries

| Area | Shared backend | Browser interface |
| --- | --- | --- |
| ADRs | Typed persistence, search, task ownership, audit history, approval commands, MCP tools | Compact task entries, authoring/detail overlay, Manage registry |
| Notifications | Private persisted inbox, approval and mention events, read/unread operations | Header inbox, source navigation, read/unread controls |
| Timeline mentions | Explicit person IDs on existing update commands, atomic notification delivery | Mention selection and rendering on new and edited posts |
| Status menu | Existing revision-checked work mutation | Three-dot actions for the selected task or subtask |
| Hide completed | No persisted preference or data mutation | Discreet default-checked checkbox, reset on reload |

The browser uses authenticated HTTP ADR and notification endpoints. There is no approval email, push service, automatic migration, or automatic change to task status. Existing AI assessment inputs are not expanded to include ADR contents or notification identities. Source availability does not imply deployment.

## ADR content and ownership

An ADR belongs to exactly one existing task or subtask. The registry aggregates those records; it does not copy decisions into a separate catalogue. The backend keeps the owning item immutable after creation and uses the item's title as context rather than adding another required ADR title. These are implementation defaults, not new user-facing fields.

Each saved record requires seven nonempty fields, corresponding to:

> In the context of **context**, facing **concern**, we decided for **decision** and neglected **alternatives**, to achieve **consequences**, accepting **downsides**, because **rationale**.

A full-document HTTP(S) link is optional. It is stored, not fetched. In this backend contract, a draft is a saved complete decision awaiting review, not storage for an incomplete form. Unsaved partial text stays in the browser form, with discard protection.

There is one requester and one approver. Each is an existing person reference or a plain name. The requester defaults to the authenticated creator when creating an ADR and can then be changed, including when recording on behalf of a team. The authenticated creator is retained separately and is never overwritten by changing the requester.

Existing people are identified by stable IDs. Plain names are searchable text, not accounts: namesakes cannot be reliably distinguished and name changes are not automatically linked. A plain-name approver matching an existing account name must instead be selected as that person. This check prevents an obvious bypass, but plain-name matching is not identity verification.

## Approval and audit

- Editors and admins may create and edit ADRs. Viewers may read them but cannot be nominated as approvers or perform approval mutations.
- An existing-person approver uses verified approval. Only that nominated account, with a current editor/admin role, may approve or request changes. An administrator cannot approve by impersonating the nominee.
- A plain-name approver uses an explicit **Record approval** action by an editor/admin. Typing a name does not approve anything. This records an assertion of approval, not a verified action by that named person.
- States are Draft, Pending approval, Approved, and Changes requested. Editing decision content or requester/approver invalidates the prior approval or pending request and returns the record to Draft. Prior history remains available. Resubmission is explicit.
- History attributes every mutation to the authenticated actor, with time and a full record snapshot. Recorded approvals retain the recorder; verified approvals retain the approving account. Do not present these as interchangeable.
- Shared mutations use the existing workspace revision and transaction lock. Stale requests fail without writes, audit additions, or notifications. Clients must read and review before retrying.
- ADR deletion is not exposed. Owning-item deletion is blocked while ADRs reference it. Referenced people and historical identities remain protected from deletion.

For local MCP, “verified” means the operation ran under the explicitly configured nominee's principal. The launcher is a trusted operator process with database access, not proof of a separate browser sign-in or a human click. Never switch its principal to manufacture approval.

Role revocation fails closed: a nominee demoted to viewer cannot approve, and mutations revalidate their eligibility. An editor/admin must replace that nominee and resubmit; existing history is retained. A pending notification can remain visible until reassignment without granting approval rights. The browser must show the server's permission/state error rather than treating an inbox item as authorization. Audit history is append-only through application operations, not tamperproof against a database operator.

## Notifications and mentions

Approval requests and mentions use one notification model. Each notification belongs to its recipient. Reads and read/unread changes cannot target another person's inbox, including from an admin principal. Read state is private and does not advance the shared workspace revision.

The backend persists notifications in the same transaction as the source mutation. No email or external delivery is involved. Source identifiers include the owning item and ADR or timeline-update ID, so the UI can navigate without guessing from text.

Mentions explicitly name existing person IDs in ADRs and timeline posts. Plain names do not receive notifications. The backend does not infer recipients from arbitrary `@name` text. On edit, newly added recipients are notified; unchanged recipients are not notified again. Self-notifications are suppressed. Removing a mention invalidates its outstanding notification, and a later re-addition can notify again. Deleting a timeline post removes its associated notifications. Obsolete approval requests are invalidated when review ends or a decision changes.

The browser release should provide an in-app inbox with unread/read state and links to the source. Mention selection must ship with approval notifications rather than adding a second notification implementation later.

## Browser interaction specification

### ADR authoring and registry

Use the existing modal/sheet primitives for create, edit, and detail views. Keep the task timeline compact. Do not add a permanently expanded seven-field form. Preserve keyboard focus, Escape behavior, responsive layout, and unsaved-change protection.

Manager gains an ADR registry with case-insensitive decision-text/document-URL search, approval-status filters, and requester/approver filters. A person filter matches either role by default, with an optional role restriction. Support plain-name filtering as well as account selection. Results open an overlay and link to the owning task.

Recorded approval should remain a small, explicit action consistent with the verified flow. Its precise presentation still needs visual review. Simplicity and consistency are acceptance criteria, not permission to hide whether an approval was recorded or verified.

### Three-dot status actions

Expose **Mark in progress**, **Mark done**, and **Move to todo** on tasks and subtasks where applicable. Do not offer the current status as an action. Change only the selected item, never automatically its parent or children. Keep existing service validation: a parent with unfinished children cannot be completed, and a completed parent must be reopened before receiving unfinished children. Do not silently weaken these rules to make a menu action succeed.

### Hide completed

Use a discreet **Hide completed** checkbox, checked on first load and reset to checked on every reload. Do not persist an unchecked preference across reloads. It is a display control, not an active filter chip, and should not trigger active-filter highlighting.

Hide completed rows, but retain a completed parent as context if unfinished children need it to remain discoverable. The current write service prevents that state in normal operation; the display rule is defensive for imported or historical data, not authorization to bypass hierarchy validation. When an explicit status filter includes Done while Hide completed is checked, show a nearby hint to uncheck the display control. Do not silently change the selected filters or the checkbox.

## Acceptance checks

Backend and MCP tests must use a disposable database with synthetic people. Cover strict schemas and bounds, task/subtask ownership, all seven fields, HTTP(S) link validation, existing-person and plain-name filtering, audit pagination, every approval transition, reapproval, stale revisions, concurrent writes, revoked roles, viewer restrictions, forged actors, notification privacy, mention additions/removals, and deletion references.

The browser work additionally needs keyboard/mobile checks, a real approval-request-to-notification-to-review workflow, source navigation, overlay draft protection, three-dot actions, reload reset for Hide completed, and regression checks against existing filters/nesting. Backend tests alone do not establish browser acceptance.

| Requirement | Executable coverage |
| --- | --- |
| Seven fields, strict identities, safe document links, bounded pagination | `tests/adr.test.ts` schema cases |
| Documented create input and registered tool names | `tests/adr.test.ts` example parsing and `tests/adr-integration.test.ts` discovery |
| Read/search/filter/history and all approval transitions | `tests/adr-integration.test.ts` SDK lifecycle |
| Actual launcher, attributed approval, rejection of a non-nominated author | `tests/adr-integration.test.ts` two-principal stdio workflow |
| Competing writes, stale rollback, forged roles, revoked approvers, no-op edits | `tests/adr-service.test.ts` transactional scenarios |
| Private notifications, read state, mention edits and old-client compatibility | `tests/adr-integration.test.ts` inbox and work-update scenarios |
| Historical references, migration repeatability, database identity constraints | `tests/adr-service.test.ts` deletion and SQL checks |
| Populated pre-ADR upgrade preserves records, revision, timestamps and attribution | `tests/adr-upgrade.test.ts` real migration replay |
| Browser session attribution, CSRF/origin rejection, strict HTTP queries/bodies, approval and inbox privacy | `tests/adr-http.test.ts` authenticated route handlers |
| Completion visibility, retained parent context, applicable non-cascading status choices | `tests/work-display.test.ts` pure display scenarios |
| Existing hierarchy, work permissions, updates and stars | `tests/work-integration.test.ts` |

These checks run against synthetic records in a disposable database. They do not exercise a live workspace, prove an ADR browser experience, or qualify a deployed release.
