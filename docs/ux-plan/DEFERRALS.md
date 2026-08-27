# UX plan — deferrals

Work named in the plan (`docs/ux-plan/index.html`) that was consciously left
undone, with the reason and what it would take. Idea numbers refer to that file.

## 61 — `--color-brand` as text misses the AA floor

`packages/ui/__tests__/tokenContrast.test.ts` holds the neutral text ladder and
the four status colours to 4.5:1 on every content surface. `--color-brand` is
excluded, and it does not clear the floor: 3.83:1 on `--color-bg-base` in light
mode, 4.06:1 in dark.

Light mode is the problem: 3.83:1 on `--color-bg-base`, down to 3.64:1 on
`--color-bg-surface`. Dark mode already passes on all four content surfaces
(4.51:1 at its tightest, on `--color-bg-surface`).

`--color-brand` is used as text (links, the inline "Account & data" links) as
well as being the identity accent behind every filled brand button, the focus
ring and the active-nav marker. Darkening it enough to pass would change the
terracotta the product is recognised by, and moving only the text uses to a
separate `--color-brand-text` token means auditing several hundred call sites to
decide which each one is. That is a brand decision with a large mechanical tail,
not a paper cut, so the guard covers what it can honestly cover and names this
rather than waiving it inside the test.

To pick it up: add `--color-brand-text` (about `#96543b` in light, 5.55:1 on
bg-base; dark can keep `--color-brand`), migrate the text-only call sites, then
add the token to `TEXT_TOKENS` in the contrast suite.

## 68 — the message breadcrumb names "Message", not the subject

`/dashboard/postbox/<folder>/<messageId>` used to print the raw `mailMessages`
id as its last crumb. It now reads `Mail > <folder> > Message`
(`app/lib/breadcrumbPatterns.ts`), which is the localized-label half of the
plan's ask.

The subject itself is not on the route, and the breadcrumb tables are pure
module scope by design. Showing it would mean a page-level query plus
`setDynamicBreadcrumbs`, on a route where `PostboxLayout` already holds the
message — i.e. either a duplicate fetch or a new emit path out of the layout,
and a trail that is blank for a beat on every message open. Not worth it for a
crumb; the reader shows the subject as its own heading one line below.
