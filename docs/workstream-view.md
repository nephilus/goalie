# Workstream review

## Navigation and scope

**Workstreams** is a Workspace destination alongside All work and My work. Its directory opens a workstream for review, rather than treating the directory row as the workstream editor. Editing the stream and creating a task remain explicit actions.

An opened stream starts in **Attention**. **All tasks** is the alternative for browsing its work without attention filtering. The login landing view remains All work. This change does not introduce an account-level default-view preference.

The workstream view reads the existing workspace snapshot. It does not add stream-level posts, a separate activity store, a background report, or new write permissions. Updates belong to individual tasks or subtasks. ADRs still belong to tasks and remain available through Updates and the ADR registry.

## Directory and task views

Directory search matches title or description, ignoring case and surrounding whitespace. Lead, linked goal, and attention filters combine. Sort choices are Name, Latest timeline, and Quiet count. Latest timeline ranks surviving task and subtask posts, not field edits. Quiet count sorts by the combined number of quiet tasks and subtasks while displaying those counts separately. Clear search and Clear filters return focus to the search field.

Directory search, filters, and sort survive section changes and saves during the mounted route, but reset on page reload. The activity window lasts while Workstreams is mounted and starts at 7 days when returning from another section. Opening a stream starts a fresh Attention task view rather than saving a personal default.

Attention shows the latest timeline entry and the specific review reasons for each flagged task or subtask. Subtasks name their parent. All tasks preserves parent/child grouping, including a context parent when only its child matches. Both views support task search, status, and ordering by latest timeline, title, due date, or current order. Hide completed starts checked. Older history expands in the row, ten entries at a time; Add update opens the existing Updates panel.

If a visible Attention item stops being flagged after an update or assessment change, it stays in place with **No longer flagged**, provided it still matches the current task filters and Hide completed setting. Current counts and reasons still update. **Refresh attention list**, a view/filter/sort/window change, or leaving and reopening the stream resets this retention. Deleted items and items moved out of the stream are not retained. The retention label does not represent a new persisted status.

## Review counts

The review window starts at **7 days**, with **14** and **30 days** available. Counts are derived on the client from the loaded snapshot and current clock, without a report request. The local clock is refreshed once a minute while Workstreams is mounted. It does not poll shared work. Counts distinguish main tasks from subtasks, including when both belong to the same parent group. Each item contributes at most once to each count.

| Count | Meaning |
| --- | --- |
| Updated | An item has a surviving timeline post within the selected rolling window, including its cutoff instant. Notes, blockers, and blocker resolutions count. Completed items can count. |
| Quiet | An In progress (`doing`) item has no timeline post within the window. If it has never had a post, its creation time must be older than the cutoff. To do and Done items never count as Quiet. |
| Blocked | An unfinished item has a nonempty current blocker. This is current state, not the number of blocker posts within the window. |
| Attention | An unfinished item is Blocked, Quiet, or has a current, in-scope Needs decision assessment. Multiple reasons do not multiply the count. |

An item's own timeline determines its Updated and Quiet counts. A child's post does not mark its parent Updated. Edits to task fields, task creation, stars, and ADR activity are not timeline posts. Editing a post does not change its creation time. Deleting a post makes the calculation fall back to surviving history, or item creation for Quiet when no posts remain.

These are reasons to inspect work, not health, urgency, or completion forecasts. No update is not evidence that no work happened.

## Optional AI

Blocked and Quiet are calculated from saved work without an AI request. Manual browsing, editing, and timeline updates do not wait for a provider.

Needs decision uses the existing assessment mechanism. Only a current assessment with a matching input key and membership in the saved Goalie scope contributes. Pending, failed, stale, refresh-required, completed, and out-of-scope results do not become new decision flags. Turning AI assistance off removes AI-derived flags rather than turning unknown state into a decision. The directory's decision-only filter is unavailable when AI assistance or saved-work assessments are off, and an existing decision-only selection stops filtering manual work.

Opening a stream supplies that stream's items as browsing candidates. The existing hook intersects those candidates with the saved assessment scope and rechecks eligibility before requests and response attachment. The server independently enforces scope. Opening a stream does not enable assessments or save a different scope. **Use current view filters** in the scope editor offers the selected stream as an explicit draft choice, still requiring Save scope.

## Editing and decisions

Task Edit and Updates actions call the existing route handlers. Creating a task from a stream opens an unsaved main-task draft with that workstream selected. Add subtask uses the existing contextual draft handler and is available only for unfinished main tasks. Only Save/Create persists changes, using the existing authorization and workspace revision checks.

Stream navigation uses the existing discard confirmation when a task, workstream, or timeline draft is dirty. Notification and ADR source navigation also waits for confirmation. Within Workstreams, an allowed source navigation selects the owning stream and opens the task's existing Updates panel. It does not create a parallel decision or update workflow.

## Implementation and verification

- `app/components/workstream-workspace.tsx` renders the directory and stream review.
- `app/lib/workstream-view.ts` derives counts, attention reasons, directory results, and retained item IDs without mutating the snapshot.
- `app/routes/work.tsx` owns navigation, editors, authorization affordances, and the existing assessment hook integration.
- `tests/workstream-view.test.ts` covers count definitions, window boundaries, directory filtering/sorting, decision freshness/scope gates, and retention with synthetic snapshots.

See [development](development.md) for test commands and isolated browser acceptance. Helper tests do not establish browser focus, responsive behavior, or authenticated mutation behavior. Source availability does not imply deployment or live-data validation.
