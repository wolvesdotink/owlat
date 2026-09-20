# App UI refinement

The app now uses one desktop navigation column. Administration, Preferences, Mail (Browse), Chat, and Assistant lend their existing navigation to the dashboard sidebar. **App navigation** switches back to the app menu; the return button restores the section. Mobile drawers remain available.

Ordinary buttons and fields are 36px, compact controls are 32px, and large actions remain 48px. Touch controls have a 44px minimum. The compose split button has equal heights, aligned edges, and a shared divider. Escape closes its menu without also changing the mail view.

Page descriptions and empty states have a quieter type hierarchy. Dashboard setup steps use a compact two-column grid on wide screens. The owl mark is visible in dark mode. Settings layouts have an element root so switching between them does not leave the page blank during layout transitions.

## Before and after

These are screenshots of the real Vue components, using the same local fixture data and viewport on both versions. Desktop captures are 1440 × 900; phone captures are 390 × 844 with touch emulation. They show layout and interaction changes, not live account data. The temporary mock client and auth interception are not part of this PR.

| Screen | Before | After |
| --- | --- | --- |
| Team administration — dark | [Before](comparison/before/admin-team--dark.png) | [After](comparison/after/admin-team--dark.png) |
| Team administration | [Before](comparison/before/admin-team.png) | [After](comparison/after/admin-team.png) |
| Chat — dark | [Before](comparison/before/chat--dark.png) | [After](comparison/after/chat--dark.png) |
| Chat — mobile | [Before](comparison/before/chat--mobile.png) | [After](comparison/after/chat--mobile.png) |
| Chat | [Before](comparison/before/chat.png) | [After](comparison/after/chat.png) |
| Dashboard — dark | [Before](comparison/before/dashboard--dark.png) | [After](comparison/after/dashboard--dark.png) |
| Dashboard — mobile | [Before](comparison/before/dashboard--mobile.png) | [After](comparison/after/dashboard--mobile.png) |
| Dashboard | [Before](comparison/before/dashboard.png) | [After](comparison/after/dashboard.png) |
| Team Inbox — dark | [Before](comparison/before/inbox-list--dark.png) | [After](comparison/after/inbox-list--dark.png) |
| Team Inbox — mobile | [Before](comparison/before/inbox-list--mobile.png) | [After](comparison/after/inbox-list--mobile.png) |
| Team Inbox | [Before](comparison/before/inbox-list.png) | [After](comparison/after/inbox-list.png) |
| Mail — dark | [Before](comparison/before/postbox--dark.png) | [After](comparison/after/postbox--dark.png) |
| Mail — mobile | [Before](comparison/before/postbox--mobile.png) | [After](comparison/after/postbox--mobile.png) |
| Mail | [Before](comparison/before/postbox.png) | [After](comparison/after/postbox.png) |
| Signatures | [Before](comparison/before/preferences-signatures.png) | [After](comparison/after/preferences-signatures.png) |

## Validation

- Web: 574 test files, 5,975 tests passed with the pre-existing untracked desktop updater test excluded. The initial unrestricted run passed 5,976 tests and failed six assertions in that unrelated local test.
- Shared UI: 18 test files, 185 tests passed.
- Browser assertions: equal split-button bounds; keyboard menu open/close; app/section switch and focus restoration; sidebar hide/reopen; Administration → Preferences navigation; selected-item visibility in a long tree; mobile overflow and desktop restoration.
- Type checking, lint, button and palette checks are recorded in the PR test plan.

[Screen inventory and review coverage](review.md) lists all 136 page components and the scope of the fixture-based browser review. Screens with missing campaign/contact/template fixtures were reviewed at source and shared-component level; their empty/not-found captures are not evidence that a populated editor or report was visually validated.
