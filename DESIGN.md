# Goalie design

## Product shape

Goalie is a focused work surface: scan cross-team work, open a record, make a small update, and return to the list. The current frontend does not serve portfolio dashboards, dependency graphs, boards, timelines, or coordination workflows. The active route is `app/routes/work.tsx`; the route adapters are in `app/routes.ts` and the shared service is in `app/server/work.server.ts`.

The UI uses existing shadcn/Radix primitives in `app/components/ui` and Lucide icons. `app/work.css` owns layout and theme tokens. There is no second UI kit or duplicate Sheet library.

## Information architecture

The work surface provides All work and My work, plus Goals, Workstreams, Shared tags, and People. Work items belong to one workstream and may have one level of subtasks. Goals link to workstreams many-to-many; an item's workstream goals are context, not individual contribution claims. Tags are reusable categories: a scoped tag belongs to one workstream, while **Common** means available to every workstream.

Rows expose typed Updates and Edit actions, contextual Add subtask/New task/New workstream actions where permitted, and private Star/Unstar state. Contextual creation opens a complete unsaved draft with the parent, workstream, or goal preselected. Only explicit Save/Create persists it. A completed root must be reopened before adding a subtask, and children cannot have grandchildren.

People is edit-only in the UI and admin-only. Existing names and app roles (`admin`, `editor`, `viewer`) can be edited after exact-target confirmation; email is immutable. There is no Add or Delete person control in the page. Trusted operator API/MCP provisioning and deletion remain separate, with self, last-admin, and reference protections. Dex authenticates; Goalie authorizes every request from the current database role.

## Responsive behavior and visual language

- At 1280px and wider, navigation, work list, and editor/Updates panel share the page. Updates reserves panel width and is non-modal.
- Below 1280px, editors use a focus-contained modal sheet. Below 900px, navigation becomes a modal drawer. Rows reflow according to their available container width, not only the viewport.
- Work and management rows retain readable titles and metadata at narrow widths. Editor actions remain reachable on short screens, with safe-area padding inside the sticky footer.
- Light, dark, and system themes use neutral surfaces, a restrained blue accent, semantic status/error colors, and system sans typography. Body and controls are 16px, secondary text 14px, record titles 18px, panel titles 24px, and page headings 32px at the default browser size.
- Interactive targets are at least 44px. There is one visible page heading; People has no creation action. Explicit open/closed root and child choices persist in browser storage when available.
- Unsaved form changes, editor switching, Refresh, and sign-out use discard protection. Confirmation dialogs own focus above editors and remain usable across responsive transitions.

## Work, filters, and updates

Work status is required (`todo`, `doing`, or `done` in the current work model). Assignment is optional; an empty `assigneeIds` array means Unassigned. The current item blocker is projected from typed `note`, `blocker`, and `blocker_resolved` updates while preserving older baseline blockers. Every new update records its authenticated author and a sorted assignee snapshot. Older null snapshots display Not recorded.

Search and each filter category use any-of semantics; different categories intersect. Status, Tags, Decisions, Workstreams, linked Workstream goals, assignees, due timing, and Starred only compose with All/My work. Clear filters preserves search and navigation mode. Unknown IDs remain restrictive and removable. Stars are account-scoped PostgreSQL preferences: they do not advance the shared revision or reveal another account's stars.

Shared mutations run through the typed schemas in `app/shared/work.ts`, authorization and transaction logic in `app/server/work.server.ts`, and the web/MCP adapters. Every shared write supplies an expected workspace revision; stale writes fail closed rather than silently rebasing a draft. Deletions are exact-target and revision-checked, block dependent records instead of cascading, and retain audit history.

## Assessments and optional suggestions

Saved-work Goalie decisions are a separate, experimental opt-in from draft assistance. A saved scope combines the account's chosen work filters and is checked server-side before work is assessed and before a result is attached. Current result labels are **Needs decision**, **Ok** (No outstanding decision evidenced), and **Unclear**. They are not health, urgency, or guaranteed absence claims. Debug inspection is off by default; diagnostics show the bounded input, rubric, model metadata, and timing only when explicitly opened.

Assessment input is deliberately bounded: UTC assessment day, saved title, description, status, blocker, and the latest 20 complete updates plus omission metadata. Dates, goals, workstreams, tags, stars, people records, IDs, unrelated work, and drafts are not provider input. Completed work is excluded; title-only records may receive a rules-only unclear result. Provider errors remain visible and require explicit recovery.

Draft Goalie Suggestions can fill only reviewable unsaved workstream, linked-goal, and eligible tag fields. A short title/description pause or blur may request assistance; workstream-goal suggestions use the existing workstream editor flow. Manual choices and removals win, stale responses are ignored, and Save/Create is the only business write. People are never assigned automatically in the UI. The provider is disabled by default and, when enabled, must pass the configured trust boundary described in [deployment](docs/deployment.md).

## Routes and adapters

`app/routes.ts` maps `/` to the work UI, `/api/*` to the work API, `/auth/*` to OIDC login/callback/logout, and `/health` to readiness. The current API resources are `/api/work`, `/api/work/assist`, `/api/work/assist/workstream`, `/api/work/assessments`, `/api/work/assessments/preference`, and `/api/work/assessments/scope`. Web writes require OIDC session authentication, same-origin/CSRF checks, and service authorization. The stdio MCP launcher (`scripts/mcp.ts`) requires `GOALIE_MCP_PERSON_ID`, reads that person from PostgreSQL before serving, and rechecks the current role during calls. It has no network listener and is not a substitute for delegated network authentication.

The active MCP tools cover identity and bounded reads; create/update/delete for goals, workstreams, work, tags, and operator-managed People; typed update operations; private stars; and read-only draft suggestions. Clients should read first and pass the returned revision to mutations. Tool annotations do not authorize destructive actions; clients must apply their own exact-target approval policy.

## Deliberate boundaries

Legacy tables and historical evaluation adapters remain in the repository and migrations for compatibility. They are not silently deleted or converted into the current `simple_*` model. There is no automatic old-data migration, automatic seeding, provider polling, background worker, hosted MCP endpoint, or automatic deployment. PostgreSQL transactions, role checks, revision checks, and bounded responses are the source of truth; UI affordances never replace server authorization.
