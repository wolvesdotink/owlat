# UX plan — deferrals

Work named in the plan (`docs/ux-plan/index.html`) that was consciously left
undone, with the reason and what it would take. Idea numbers refer to that file.

## 9 — recipient timezone is read from the CRM, not inferred from headers

The schedule dialog is timezone-aware: it offers a preset anchored on the
recipient's morning, labels every preset with both clocks, names the zone it is
reading against, and degrades silently to the sender-clock presets when it does
not know. The next-weekday-morning preset landed too.

What the plan asked for and this does NOT do is _infer_ the zone "from prior
message headers". Nothing in `mailMessages` carries the sender's UTC offset:
the Date header's offset is discarded at ingest and `internalDate` is set to
`receivedAt` (`mail/deliveryPipeline/insert.ts`), so both stored timestamps are
plain epochs with no zone in them. Inferring would mean capturing the offset in
the inbound delivery pipeline, a schema field, and a backfill that cannot exist
for mail already received — i.e. a change to the inbound plane that yields
nothing for any existing mailbox.

So the source is `contacts.timezone`, the IANA zone the CRM already holds
(`mail/contacts.ts:recipientTimeZones`). It is stronger evidence than a header
guess — someone set it explicitly — and it is available today; it is just
narrower, since it only covers recipients who are CRM contacts with the field
filled in.

To pick it up: parse the Date header's offset at ingest, store it as an
optional field on `mailMessages`, and prefer the CRM zone over a header-derived
one when both exist (an explicit setting should beat a statistical read of
where someone's mail client was last configured).

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

## 26 — "last opened" is inferred, and the volume column is a window

The subscriptions panel ships whole: grouped senders, multi-select, the batch
unsubscribe-and-archive over the existing RFC 8058 one-click flow, and a
per-sender partial-failure summary. Two of its numbers are narrower than the
plan's mockup implies, and the UI is worded so it does not overclaim.

**"Last opened" is not a timestamp anyone recorded.** Nothing stores when a
message was opened — `mailMessages` carries `flagSeen` and nothing beside it, and
`updatedAt` moves on any flag, label or folder change, so it is not a read
marker. `mail/subscriptions.ts` therefore reports the _arrival time of the newest
message from that sender which has been read_, and the column says "Opened 6
months ago" on that basis. The signal the panel is really built around —
`lastReadAt === null`, i.e. nothing from this sender was ever opened — is exact;
the elapsed time on the ones you did read is an approximation that skews old for
a sender you read late.

To pick it up: stamp a `readAt` on the message (or the thread) in the mark-read
paths — `messageActions.setFlags` and `markThreadRead` — and prefer it over the
arrival time when present. Existing mail has no value to backfill, so the panel
would read from both for a long time.

**Volume counts the scanned window, not the mailbox.** The query reads the newest
`SUBSCRIPTION_SCAN_LIMIT` (300) inbox messages. A Convex query is a transaction
with a read budget and a message row can carry a 64 KiB inline body, so an
unbounded folder walk would be worst on exactly the newsletter-heavy mailboxes
this feature exists for. The panel says which window the numbers describe
(`windowNote`) when the scan was truncated rather than presenting them as totals.

To pick it up: denormalize a per-sender counter (a `mailListSenders` sidecar
maintained at ingest, the shape `mailContacts` already uses) so volume is O(1)
and genuinely all-time, and keep this scan only as the fallback for mail that
arrived before the counter existed.
