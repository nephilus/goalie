# Goalie product brief

## Purpose

Goalie is self-hosted work tracking for teams that need a shared view across persistent workstreams without first adopting a portfolio-planning system. A person uses the web UI; a trusted local agent can use the stdio MCP server. Both use the same typed, authorized application operations.

## Current capabilities

- Goals linked to workstreams many-to-many.
- Work items with one home workstream, required status (`todo`, `doing`, `done`), optional assignees, due date, blocker, tags, one-level subtasks, and typed updates.
- All work/My work views with search, multi-select filters, workstream-goal context, and private per-account stars.
- A separate Workstreams workspace: directory search and filters, Attention by default inside a stream, All tasks as an alternative, and on-demand 7-, 14-, or 30-day review counts. Task timelines remain the update source. See [workstream review](docs/workstream-view.md).
- Admin-only editing of existing People records; email is immutable and roles are `admin`, `editor`, or `viewer`.
- Exact-target, revision-checked mutations that block dependent deletions rather than cascading.
- Optional draft Goalie Suggestions and separately opted-in saved-work decisions. Both are disabled unless explicitly configured; suggestions never save or assign people automatically.
- A bounded, local stdio MCP surface requiring an explicitly provisioned person ID. It is not a network service.

## Roles

- **Viewer:** reads shared work and ADRs and may manage private stars and their own notification read state. Cannot be nominated as an ADR approver.
- **Editor:** creates and edits ordinary work, goals, workstreams, tags within assigned governance, and updates.
- **Admin:** governs Common tags, manages People through the application controls, and retains administrator-only operator operations.
- **Workstream lead:** manages tags scoped to that workstream and linked goals according to current authorization rules.

The server rechecks the current database role inside the transaction boundary. UI hiding is convenience, not an authorization boundary.

## Principles and non-goals

Goalie keeps incomplete information visible, avoids invented dependencies or ownership, and makes Save/Create the explicit persistence step. Stars are private watch preferences, not priority labels. Workstream Attention names specific reasons to review work, not an overall health or urgency score. Opening a stream does not change the default view. The sidebar footer separately saves an All work or Workstreams landing preference per account in this browser. It is not a hosted public service, autonomous coordinator, portfolio suite, issue-tracker replacement, or health/urgency classifier. Legacy tables and migrations remain for compatibility but are not part of the current UI model.

## Technical contract

The web app uses OIDC sessions, PostgreSQL, same-origin/CSRF checks, and revision-checked shared writes. The local MCP launcher uses database access and an explicitly configured `GOALIE_MCP_PERSON_ID`; clients must treat it as a trusted operator process. Optional provider egress is bounded and requires an explicit trusted origin. See [DESIGN.md](DESIGN.md) and [deployment](docs/deployment.md).

## Accessibility and inclusion

The interface is keyboard-operable, responsive, theme-aware, and uses readable labels, semantic form structure, explicit errors, focus-managed dialogs, and exact-target confirmations. Unauthorized shared operations are disabled in the UI and independently rejected by the server.

## ADR scope

The [agreed feature specification](docs/adr-spec.md) adds seven-field task ADRs with an editable requester, one approver, audit history, and recorded versus verified approval. The backend and [MCP tools](docs/mcp.md) also support approval notifications and explicit mentions. ADRs are independent of optional AI assessments and do not require an AI provider.

The browser exposes compact task ADR entries, overlay authoring and review, a searchable Manage registry, an in-app notification inbox, and explicit mention controls. Three-dot status actions change only the selected task or subtask. A discreet Hide completed checkbox resets to checked on reload and is separate from active filters. The UI reuses existing primitives and calls the [session-authenticated browser API](docs/adr-browser.md). Deployment remains an explicit operator action.
