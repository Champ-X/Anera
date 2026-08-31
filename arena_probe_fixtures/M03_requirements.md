# Parcel Workspace — Draft Requirements v0.7

This document intentionally contains unresolved conflicts. Requirement IDs are stable and must be preserved during review.

## Product scope

- **FUN-001** Users can create, rename, archive, and restore workspaces.
- **FUN-002** A workspace contains tasks, comments, attachments, and an activity timeline.
- **FUN-003** Users can export a workspace as CSV, including tasks, owners, dates, and status.
- **FUN-004** Export must include comments and attachment metadata.
- **FUN-005** Workspace export is JSON-only so that nested comments and attachments are never flattened.
- **FUN-006** Search covers workspace name, task title, task description, and comments.
- **FUN-007** Deleted tasks remain recoverable until the applicable retention window expires.

## Roles and permissions

- **AUTH-001** Viewers can read tasks and comments but cannot create or edit content.
- **AUTH-002** Editors can create tasks, edit tasks, comment, upload attachments, and invite new members.
- **AUTH-003** Admins can manage billing, roles, integrations, retention settings, and workspace deletion.
- **AUTH-004** Only Admins can invite or remove workspace members.
- **AUTH-005** An Editor cannot promote any user to Admin.
- **AUTH-006** Every role-changing action must appear in the activity timeline with actor, old role, new role, and timestamp.

## Data and retention

- **DATA-001** Archived workspace data is retained for 30 days and then permanently deleted.
- **DATA-002** All customer workspace data, including deleted content, must be retained for at least 90 days.
- **DATA-003** Activity records are immutable from the product UI.
- **DATA-004** Attachments may be up to 25 MB each.
- **DATA-005** The system stores all timestamps in UTC and renders them in the viewer's selected timezone.
- **DATA-006** Exported files must not contain internal database identifiers.

## Performance and availability

- **PERF-001** Search responses should complete within 2 seconds at p95 for workspaces containing up to 100,000 tasks.
- **PERF-002** Workspace export must run synchronously in the browser and return within 5 seconds for every workspace size.
- **PERF-003** The activity timeline loads the newest 50 events initially and paginates older events.
- **PERF-004** The service availability target is 99.9% per calendar month, excluding announced maintenance.
- **PERF-005** User-visible mutations must be idempotent when retried with the same idempotency key.

## Security and privacy

- **SEC-001** All external integrations use least-privilege OAuth scopes.
- **SEC-002** Secrets, session tokens, and raw authorization headers must never appear in application logs.
- **SEC-003** Destructive workspace deletion requires an explicit confirmation that includes the workspace name.
- **SEC-004** Export downloads expire after 15 minutes and are scoped to the requesting user.
- **SEC-005** Attachments are scanned before they become available to other members.
- **SEC-006** Audit events must record denied permission checks without storing sensitive request payloads.

## Accessibility and compatibility

- **UX-001** All core task workflows meet WCAG 2.2 AA keyboard and contrast requirements.
- **UX-002** The supported browsers are the latest two stable versions of Chrome, Edge, Firefox, and Safari.
- **UX-003** Reduced-motion preferences disable non-essential animation.
- **UX-004** Error messages identify the failed operation and a safe recovery action without exposing stack traces.

## Open notes from stakeholders

- **NOTE-001** Legal prefers 90-day retention; Product previously promised 30-day deletion in marketing copy.
- **NOTE-002** Customer Success requests CSV because customers use spreadsheets; Engineering prefers JSON for nested data.
- **NOTE-003** Sales wants Editors to invite teammates; Security wants membership changes restricted to Admins.
- **NOTE-004** Large exports may need background jobs, but no owner has approved that architecture.
