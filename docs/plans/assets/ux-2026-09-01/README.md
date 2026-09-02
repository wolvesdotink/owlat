# UX pass, 2026-09-01 — before/after captures

Side-by-side captures for the UX implementation PR. BEFORE panes come from
the 2026-08-21/29 review captures; AFTER panes were taken from the merged
branch state with the same mock-backend harness (1440px desktop, 390px
mobile; full-page shots cropped to the first ~900px).

| File | What to look at |
| --- | --- |
| `dashboard.png` | First paint: splash-owl spinner collapse vs the full grid with content-shaped loading |
| `dashboard--mobile.png` | Getting-started rows un-squeezed; new bottom tab bar with the centred create action |
| `campaigns-new.png` | Wizard step in the URL, neutral selection cards instead of painted terracotta |
| `contacts-list--mobile.png` | Header no longer clips the primary action; card list instead of a cut-off table |
| `audience.png` | Shared UiPageHeader ladder across the audience group |
| `admin-index.png` | Terracotta demoted, persistent admin rail |
| `delivery-index.png` | Settings rail with the Advanced group un-hidden |
| `delivery-transport.png` | Honest no-status/loading states instead of false zeros |
| `instance-features.png` | Neutral toggle tracks, rail navigation |
| `chat--mobile.png` | Conversation drawer exists on phones (rail was display-hidden before) |
| `inbox-list.png` | Rebuilt empty states on the eyebrow/heading/lead/action ladder |
| `setup-mode.png` | Monochrome step rail and neutral selection in the setup wizard |
| `ix-command-palette.png` | Palette with real shadow, full route coverage, create verbs that act |
| `ix-quick-create-menu.png` | New: the header "New" split button |
| `ix-contacts-add-bottom-sheet.png` | New: dialogs render as bottom sheets on phones |
