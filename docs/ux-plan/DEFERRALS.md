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

## 22 — the permission gate is in TypeScript, and the away-summary is per session

Quiet hours (window + weekday mask, evaluated in `notificationRules.ts`, with
the suppressed toasts rolled into one "N while you were away" notification),
the per-thread reply alert, the permission flow (check / request / test button
/ denied banner) and the hide-preview toggle all landed. Two edges did not.

**The permission check gates the callers, not the Rust commands.**
`useDesktopNotifications` refuses to send when the plugin reports `denied`, and
`apps/desktop/src/notifications.ts` wraps `isPermissionGranted` /
`requestPermission` around the bridge. The Rust side is unchanged:
`send_native_notification` still calls `.show()` unconditionally, and
`send_actionable_notification` goes around the plugin entirely on macOS and
Linux (mac-notification-sys / notify-rust, because the Tauri plugin only
renders action buttons on mobile). So a future caller that invokes those
commands without asking the composable first would be back where we started.
The brief asked to keep `src-tauri` changes minimal, and a permission check
inside those commands is not a one-liner: mac-notification-sys has no
permission API of its own, so the command would have to consult the plugin's
stored state before falling through to the native crate.

To pick it up: read the plugin permission at the top of both commands
(`app.notification().permission_state()`) and return an error variant the
webview can surface, instead of relying on every call site to have asked.

**The away-summary count lives in the composable, not on disk.** The suppressed
count is plain module state in the running session (`stepQuietHours` is pure and
takes it as an argument, so the storage choice is the caller's). Quitting the
app mid-window therefore loses the tally, and the summary that would have fired
at 07:00 never does — the mail is all still there, unread and badged, so nothing
is hidden, but the roll-up is missed. Persisting it would mean a new device-local
store key and a decision about what a stale count from three days ago means.

To pick it up: keep `{ quiet, deferred, windowStartedAt }` in the desktop app
settings store, and discard it on load when `windowStartedAt` is older than one
day so a long-closed laptop never greets the user with a stale number.

## 33 — pinned saved searches carry no unread count

The rail mockup labels each pinned search with a count ("Unread from Ines 3").
The rail renders the name and links to `?q=…`; it does not render a number.

A count is not a cheap read here. A saved search is a raw query string, so the
count is "run this search and tell me how many rows survive" — the same
post-filtered, cursor-paginated scan the results list runs, per pinned entry,
live, on every mailbox render. `mailFolders.unseenCount` and the label views can
be counted because a folder or a label is an indexed equality; an arbitrary
conjunction of substring operators, size bounds, exclusions and an OR is not.
Approximating it from the first page only would print a number that is right for
small results and quietly wrong (capped at the page size) for exactly the
searches worth pinning.

To pick it up: give the backend a `countSavedSearch` query that walks the same
scan with a hard ceiling and returns `{ count, isCapped }`, so the rail can
render "12" honestly and "50+" honestly, and subscribe it per pinned entry with
the existing chunk-warmup batching rather than one subscription per row.

## 35 — `filename:` searches attachment metadata, not an attachment index

The plan pairs `filename:` with idea 37's attachment index. It landed without
one: `mailMessages.attachments` already carries every part's filename from
ingest, so the operator is a real post-filter today and needs no "not yet
indexed" state.

What it does NOT have is index narrowing. `filename:invoice` with no free text
walks the arrival index and filters a page at a time, so on a large mailbox the
matches can sit several "Keep searching" pages deep — the same shape as
`has:attachment` alone, and the page-empty-with-more state already tells the
truth about it. The same is true of `larger:`/`smaller:`, of the exclusions, and
of any query using `OR` (a disjunction has no single text every alternative
shares, so it gives up the search index entirely).

To pick it up: idea 37's attachment index, plus a search-index filter field for
the size buckets, so those queries narrow the scan instead of only the page.

## 36 — a fan-out FREE-TEXT search returns one page per mailbox

`mail/mailbox/search.ts` now searches many mailboxes at once and merges the
slices newest-first, and the merge is fully paginated: each mailbox carries its
own keyset position inside one opaque cursor, so "Load more" walks the union
without skipping or repeating a row.

That holds for every query that runs off the arrival index. It does NOT hold for
a fan-out query with FREE TEXT. Convex allows exactly one `.paginate()` per
function execution, so N mailboxes cannot each paginate natively, and the manual
keyset the fan-out uses instead needs an ordered key — which the full-text
search index does not expose (it is relevance-ordered and has no cursor of its
own). Each mailbox therefore contributes its top page of text hits and is
reported as complete: the merge drops such a mailbox from the cursor even when
the page `limit` cut some of its hits off, because a resume position would point
back into the same relevance page and hand those rows out twice. Truncated text
hits are dropped, never repeated. Both consumers are first-page consumers — the
Cmd-K palette shows five rows, and the Postbox search page still calls the
single-mailbox path, which paginates natively and reaches every match — so
nothing on screen today is truncated in a way the user can see.

To pick it up: give the search branch an orderable key. Either add `receivedAt`
as a search-index filter field and page it in time buckets, or run the fan-out
text search through a paginated per-mailbox action that merges outside a single
query execution.

## 51 — the danger marker reaches the message list, not the grouped thread views

Thread rows carry the marker (`utils/senderAuth.ts` `deriveSenderRowMarker`,
rendered by `PostboxThreadRow.vue` behind the `senderAuthBadges` flag), so the
folder list, the search results pane, the label view and the Today view all
show it: they all render through `PostboxThreadList`.

`PostboxThreadGroupList` and `PostboxThreadCategoryList` do not. Those two
render one row per THREAD, off `mailThreads` aggregates — `latestFromAddress`,
`latestSubject`, counts — and a thread row carries no authentication verdicts at
all. The verdicts live on `mailMessages` (`spfResult`, `dkimResult`,
`dmarcResult`, the two alignment domains, `senderHeuristics`), one set per
message, and a conversation can mix a genuine reply with a spoofed one.

Marking those rows means either a per-row read of the thread's latest message
(one extra document get per visible row, on the two surfaces built for large
folders) or denormalizing a "worst verdict in this thread" onto `mailThreads` at
ingest — a new field, a new writer, and a decision about what the aggregate of
two disagreeing messages means. Neither is a chip.

To pick it up: denormalize the latest inbound message's verdict + look-alike
flag onto `mailThreads` in the delivery pipeline (beside `latestFromAddress`,
which is maintained there already) and derive the row marker from that, so the
grouped views cost nothing extra to mark.

The plan's brief also mentions tuning "all three densities". There are two
(`comfortable` and `compact`, `utils/postboxDensity.ts`); the marker is tuned
for both, plus the touch variant of compact, which gets its label back along
with the 44px row floor.

## 52 — Return-Path is the envelope DOMAIN, and the panel reads parsed headers

The message-details disclosure shows From, Reply-To (highlighted when it points
at another domain), each SPF/DKIM/DMARC verdict with the domain it actually
authenticated, the published DMARC policy, the honoured ARC sealer, the
Message-ID and a download of the original `.eml`.

Two things are narrower than the mockup implies.

**The Return-Path row is a domain, not an address.** The inbound pipeline
persists `envelopeFromDomain` — the MAIL FROM domain SPF authenticated — and
never stores the full envelope sender address; the literal `Return-Path:` header
exists only inside the raw `.eml` blob. The row is labelled as the envelope
sender's domain and says which check used it, rather than presenting a domain as
if it were the address.

**The panel reads the fields we parsed at ingest, not the raw header block.**
`getMessageDetails` is a Convex query, and queries cannot read storage blobs
(`ctx.storage.get` is action-only). Serving the literal header block would mean
an action that fetches the whole message — potentially megabytes, per message
open, to print a dozen lines. "Download original (.eml)" already hands over the
exact bytes for anyone who wants to read the headers themselves.

To pick it up: parse and persist the `Return-Path` address at ingest beside
`envelopeFromDomain` (a one-line addition to the insert path, with no backfill
possible for existing mail), and — if the literal block is ever wanted in-app —
add a header-only action that byte-range-fetches the top of the blob rather than
the whole message.

## 57 — passkeys need a BetterAuth major the Convex adapter forbids

Sessions and TOTP two-factor both shipped. Passkeys did not, and the reason is
a version wall rather than a design question.

BetterAuth stopped shipping the passkey plugin inside the main package: `1.6.25`
(what this repo pins) exports no `better-auth/plugins/passkey`, has no
`passkeyClient` in `better-auth/client/plugins`, and carries no WebAuthn code at
all. The plugin now lives in `@better-auth/passkey`, whose FIRST release is
`1.7.0-beta.1` and whose peer range is `better-auth: ^1.7.2`.

That range cannot be satisfied here. `@convex-dev/better-auth@0.12.5` — the
adapter the whole auth plane runs through — peers `better-auth: >=1.6.11 <1.7.0`,
which is why the root `package.json` catalog pins `>=1.6.22 <1.7.0`. Installing
the passkey plugin therefore means moving BetterAuth to 1.7.x, which means
waiting for (or driving) a `@convex-dev/better-auth` release that supports it,
and re-diffing `convex/betterAuth/schema.ts` against the new bundled schema.

The database side is already in place: the `passkey` table exists in
`convex/betterAuth/schema.ts` with `credentialID` and `userId` indexes, and
`authSchemaParity.test.ts` will hold it against the plugin's declared fields the
moment the plugin is added to the options.

To pick it up: bump `@convex-dev/better-auth` to a release peering `better-auth`
1.7.x, move the catalog pin, add `@better-auth/passkey` to `apps/api` and
`apps/web`, register `passkey({ rpID, rpName, origin })` in the plugin list (the
origin list has to cover `tauri://localhost` and `https://tauri.localhost` for
the desktop webview, which WebAuthn will likely reject — worth checking before
promising desktop support), add `passkeyClient()` in `app/lib/auth-client.ts`,
and hang an add/name/remove section off the existing sign-in and security page,
which already has the card layout and the enrolment-dialog pattern for it.

## 60 — device settings are no longer reachable before a workspace is connected

`/desktop/settings` is now a redirect into `/dashboard/preferences/device`, the
"This device" section of the Preferences layout, and the standalone 441-line
island is gone with its titlebar, its `layout: false` and its duplicate
appearance and notification controls.

What that costs is the pre-connection case. The old page rendered outside
`/dashboard`, so the native menu's Settings item worked with no workspace and no
session: launch a fresh install, and you could still set the theme, turn on
launch-at-login, turn off automatic update checks and read the "make Owlat your
default mail app" steps before connecting to anything. The new home is a
dashboard route, and a dashboard route needs a workspace, so the redirect sends
a visitor with none to `/desktop/welcome` instead. Those four device-global
switches are unreachable until a workspace exists.

The route stays allow-listed in `middleware/desktop-workspace.global.ts` so the
redirect page itself gets to make that decision rather than being bounced first;
everything device-local that a connected user can reach is unchanged.

To pick it up: the settings the pre-connection case needs are the four global
ones, and they are already a self-contained group on the device page
(`#startup`, `#updates`, `#default-app`) reading `useDesktopAppSettings` and
`useDesktopSettings`, neither of which touches Convex. Extract that group into a
component and render it from `/desktop/welcome` — the screen someone with no
workspace is already looking at — rather than reviving a second settings route.

## 37 — emailed attachments are indexed for browsing, not for the assistant

`mailAttachments` (schema/mail.ts, written by `mail/attachmentIndex.ts`) makes
every attachment's filename, type, size, sender and date indexable, which is
what the Files view browses and what turns `filename:` from a post-filter over
one page of recent mail into an actual search. The resumable backfill covers
mail that predates the index.

What the plan also asked for and this does NOT do is ingest mail attachments
into the SEMANTIC file store, so the assistant can answer questions about an
emailed PDF. That is a different pipeline, not a bigger index: `semanticFiles`
holds extracted text plus a 1536-dimension embedding per chunk, produced by
`semanticFileProcessing` (a Node action that downloads the blob, extracts text
per format and calls the embedding provider). Attachment CONTENT is not stored
separately at all — it lives inside the raw `.eml` in `ctx.storage`, and the
Files view extracts a part client-side on demand — so ingesting would mean
server-side MIME extraction per part, a re-upload per attachment, an embedding
spend per document, and a contact-scope decision for every chunk (mail from
contact A must not become retrievable while drafting to contact B). Each of
those is a policy question, not a mechanical extension of a junction table.

To pick it up: extract parts server-side in the delivery pipeline for the
previewable/document kinds only, write each as a `semanticFiles` row scoped to
the sender's contact, and gate the whole path on the existing AI budget/flag —
then `mailAttachments.messageId` is already the join back to the mail.

## 37 — `filename:` uses the attachment index on one mailbox, not across a fan-out

A text-free `filename:` query on a SINGLE mailbox scans `search_filenames` and
therefore reaches attachments of any age (`mailbox/search.ts::searchByFilename`).
The fan-out path — `mailboxIds`, or passing neither `mailboxId` nor `mailboxIds`
to search every readable mailbox — still walks each mailbox's arrival index and
matches filenames in the post-filter, so a `filename:` search across several
mailboxes reaches only as deep as the merged arrival window.

The blocker is the cursor: fan-out merges one keyset per mailbox into a single
opaque multi-cursor (`mailbox/searchCursor.ts`), and those keysets are
`mailMessages` positions ordered by `receivedAt`. An attachment-index keyset is
a different table with a relevance order, so mixing the two would mean a second
cursor flavour inside the same encoded blob and a merge that cannot compare
positions across the two.

To pick it up: make the multi-cursor tagged (`{kind: 'messages' | 'attachments',
position}`) and merge attachment pages on their row's `receivedAt`, which the
junction already denormalizes for exactly this kind of ordering.

## 39 — "run on existing mail" never forwards, deletes or discards

`mail/filterRun.ts` sweeps the backlog a rule was written for and applies its
`moveToFolder`, `addLabel`, `markRead` and `markFlagged` actions, resumably and
idempotently. The other three action types are skipped, and the UI says so
rather than offering a run that would silently do nothing.

This is a deliberate refusal, not a gap in the implementation. `forward` would
mail an arbitrary depth of archive to a third party the moment someone ran a
rule they wrote for future mail; `delete` and `discard` destroy messages with
nothing to undo them. All three were authored to describe what should happen at
the inbound moment, and a retroactive sweep is a different question the user was
never asked. The four that do run are each reversible by hand.

To pick it up, the missing piece is consent, not code: a per-run confirmation
that names the destructive action and the count it would touch (which the
dry-run preview already computes), plus an undo journal for the delete case.

## 62 — the thread row stays a composite `option`, so two axe rules stay open

`app/components/postbox/__tests__/postboxA11y.test.ts` audits the four Postbox
surfaces with axe and the real message catalog. Three rule families the rows
were failing are fixed (`aria-required-parent`, `aria-required-children` for the
`<li>`, `listitem` — one `role="none"`), along with the two label defects the
suite was written for and an unlabelled hidden file input in the composer
footer. Two violations on the thread list are pinned rather than fixed:

- `nested-interactive` — each row's link carries `role="option"` and CONTAINS
  the bulk-select checkbox button;
- `aria-required-children` — the hover quick-actions (star / read / archive)
  sit beside the link inside the same `<li>`, so the surrounding
  `role="listbox"` would own buttons it may not own.

Both say the same thing: a row is a composite widget, and `listbox`/`option` is
a single-value selection pattern that does not admit controls inside an option.
The list's keyboard model is built on that pattern — `aria-activedescendant` on
the `<ul>`, arrow keys, and the row shortcuts — so the fix is not an attribute
but a different pattern: `role="grid"` with one `row` per message and a
`gridcell` per control, with two-dimensional arrow navigation to match. That is
a keyboard-behaviour change for the screen people spend their day in, and it
wants its own idea and its own review.

The suite pins the exact violation COUNT as well as the two rule names, so
closing either one fails the test and forces the exemption to be retired rather
than quietly widened.

To pick it up: move the row to the grid pattern (or move the checkbox and the
quick-actions out of the option and reach them with a roving tabindex), then
delete `KNOWN_COMPOSITE_ROW_GAPS` from the suite.
