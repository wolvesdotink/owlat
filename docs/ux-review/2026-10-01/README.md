# Owlat UI/UX review — 1 October 2026

Reviewed source: `6a0388155f9a1dac7bb071ad50d68afb957cae9d` (v0.6.6).

The most valuable next step is to make the interface trustworthy under interruption: the preview should match the submitted data, saved state should match active state, failed actions should keep the user's work, and the core tasks should work with a keyboard and on a phone. The existing palette and component system provide a useful foundation; the proposals reuse neutral surfaces, terracotta accents and the project's type hierarchy.

## Scope and evidence

- Read the project instructions, design tokens, existing UI polish review and relevant domain definitions. Reviewed the dashboard shell, data/query controls, campaign wizard, template selection, automation editor and save logic, contact import, Assistant, Chat and mail scheduling. Followed relevant frontend paths into the campaign send constraint.
- Inspected ten primary routes with populated or appropriate empty fixtures: Workbench, Assistant, Contacts, campaign creation, automation editing, Mail, Team Inbox, Knowledge, team administration and signatures. Also inspected the automation list. Desktop captures use 1280×800; phone checks use 390×844.
- Used the shared T3 browser first. When it explicitly reported its automation host unavailable, continued in local headless Chrome. Both used a temporary copy of the reviewed tree with a dev-only mocked Convex/auth transport. The harness and its modifications are **not** included in this branch.
- Confirmed the CSV preview/submission mismatch, Assistant failed-send draft loss, Assistant composing-Enter submission, Assistant conversation selection semantics and the automation phone layout. Other tickets accurately identify source-confirmed findings and proposed interactions.
- Ran six relevant existing Vitest files: **136 tests passed**. These cover CSV/import dialogs, automation rendering, wizard URL state, Chat send acknowledgement and scheduling presets. Their passing result does not cover the newly identified failure, keyboard or pagination cases.
- Checked existing open and relevant closed issues. Kept #721, #910, #1002–#1007 and the earlier UI review separate; these proposals do not refile their existing work.

This is an in-depth review of the main web interfaces, not a claim that every route, native desktop behavior, production account, screen reader or native IME was exercised. Browser writes were intercepted. Fixture gaps (for example sender readiness) are not reported as product bugs. The schedule, streaming-reader behavior, template cap and campaign body continuity are supported by code; their complete live-service journeys need implementation-time testing.

## Implementation order

1. **Protect trust and data:** CSV identity mapping, automation persistence/activation, Assistant draft recovery and composition-safe Enter.
2. **Make core tasks reachable:** automation phone editing and keyboard controls, reliable template discovery and continuous campaign composition.
3. **Polish continuity and recovery:** automation draft preservation, Assistant reading position and accessibility, schedule validation/timezone clarity.

Use shared controls and save-status language. Keep dirty-draft preservation and save/activation work coordinated. Preserve localized text and reduced-motion/focus behavior. Follow `CLAUDE.md`'s matched before/after screenshots for implementation PRs.

## Visual proposals

These are illustrative wireframes, **not implemented after screenshots**. Every proposal has a PNG for issue rendering and an editable SVG. The `current/` directory contains selected screenshots of the real Vue interface using fixture data; none contains production account data.

| Priority | Improvement | Proposal |
| --- | --- | --- |
| P1 | CSV import: resolve conflicting identity mappings before preview and submission | [PNG](proposals/csv-identity-mapping.png) · [SVG](proposals/csv-identity-mapping.svg) |
| P1 | Automations: make save status and activation reflect the persisted configuration | [PNG](proposals/automation-save-activation.png) · [SVG](proposals/automation-save-activation.svg) |
| P2 | Automations: preserve pending or failed step edits across inspector and structure changes | [PNG](proposals/automation-draft-preservation.png) · [SVG](proposals/automation-draft-preservation.svg) |
| P2 | Automation builder: support keyboard step selection and reordering | [PNG](proposals/automation-keyboard.png) · [SVG](proposals/automation-keyboard.svg) |
| P2 | Automation builder: replace the fixed inspector with a responsive sheet on narrow screens | [PNG](proposals/automation-responsive.png) · [SVG](proposals/automation-responsive.svg) |
| P2 | Campaign and automation template pickers: search and select templates beyond the first page | [PNG](proposals/template-picker-pagination.png) · [SVG](proposals/template-picker-pagination.svg) |
| P2 | Campaign creation: compose new email content before advancing to review | [PNG](proposals/campaign-compose-continuity.png) · [SVG](proposals/campaign-compose-continuity.svg) |
| P1 | Assistant: retain questions until send succeeds and offer inline retry | [PNG](proposals/assistant-draft-recovery.png) · [SVG](proposals/assistant-draft-recovery.svg) |
| P2 | Assistant: preserve reading position while responses stream | [PNG](proposals/assistant-reading-position.png) · [SVG](proposals/assistant-reading-position.svg) |
| P2 | Assistant: make conversation selection and the question field accessible | [PNG](proposals/assistant-keyboard-access.png) · [SVG](proposals/assistant-keyboard-access.svg) |
| P1 | Chat and Assistant: do not send messages while Enter confirms IME composition | [PNG](proposals/composer-ime-enter.png) · [SVG](proposals/composer-ime-enter.svg) |
| P2 | Schedule send: explain invalid custom times and show the scheduling timezone | [PNG](proposals/schedule-validation.png) · [SVG](proposals/schedule-validation.svg) |

The issue register will be added after the individual tickets are published.
