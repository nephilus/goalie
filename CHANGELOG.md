# Changelog

This file records public releases and the current unreleased capability set. Private deployment receipts, local runtime paths, evaluation artifacts, and operator diaries are intentionally not part of the public changelog.

## Unreleased

- Current work UI for goals, workstreams, work items, one-level subtasks, tags, typed updates, filters, private stars, and edit-only People management.
- Shared revision-checked application operations used by both the web adapter and trusted local stdio MCP adapter.
- Optional draft Goalie Suggestions and separately opted-in saved-work decision assessments, disabled by default and never automatically persisted.
- Remote HTTPS OpenJev assistance requires an explicit matching `OPENJEV_TRUSTED_ORIGIN`; existing installations must configure it before enabling remote assistance after upgrade. Explicit-port HTTP loopback fixtures remain supported.
- Pinned Node/Bun container build, non-root runtime, explicit migration runner, reusable CI workflow, and Release Please configuration prepared for owner setup.

Release Please creates the first versioned entry after the repository is initialized and Conventional Commit history is available. No public release or registry publication is claimed by this entry.
