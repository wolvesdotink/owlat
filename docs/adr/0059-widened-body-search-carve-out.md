# ADR-0059: Widen the sealed-at-rest plaintext carve-out for body search, behind an instance opt-in

## Status

Accepted. Amends the "Deliberate exceptions (stay plaintext)" section of the
Sealed Mail at-rest design (piece E8b, `apps/docs/content/en/3.developer/21.sealed-mail-at-rest.md`)
for one field on one table. It does **not** reopen the sealing decision itself,
and it changes nothing about the four other search fields listed there.

## Context

Every message body Owlat stores is sealed at rest with an instance data key
(`lib/atRestBodies.ts`). Convex full-text search indexes the **plaintext** of a
`searchField`, so anything searchable is, by construction, a hole in that seal.
E8b named the hole and kept it small: `mailMessages.snippet`, the first 200
characters of a message, is "a short excerpt, never the full body".

Two hundred characters is the wrong ceiling for the job the field is doing.

- `snippet` is the **only** indexed body text. There is no second, deeper index
  and no fallback scan, so a phrase at character 1,400 of a contract is not
  merely ranked lower — it is unreachable.
- The failure is **silent and indistinguishable from absence**. The user
  searches `"penalty clause"`, gets "No results", and concludes the email does
  not exist. Nothing in the product says "the index stops at 200 characters",
  so the natural reading of an empty result is a false one.
- The workaround is worse than the problem. People forward mail to a third-party
  search tool, or keep a second copy somewhere unsealed, which relocates the
  plaintext to a place the instance operator does not control at all.

The obvious counter-argument is that widening the plaintext excerpt weakens what
sealing at rest buys. That is true, and it is the reason this is an ADR rather
than a field addition: the honest framing is not "should search be good" but
"who decides, per instance, how much readable text a database dump contains".

Idea 49's offline search over cached bodies is the no-tradeoff alternative for
mail the client has already downloaded, and it remains the better answer for
that subset. It is not a server-side answer: it covers only cached mail, only
on a device that has done the caching, and it does nothing for a shared inbox
or for a fresh device.

## Decision

**1. A second, deeper column — `mailMessages.searchBody`.** A normalized excerpt
of the same body `snippet` takes its first 200 characters from, capped at 8,000
characters (`SEARCH_BODY_MAX_CHARS`, mid-band of the plan's 4-16KB). Whitespace
is collapsed and HTML is reduced to text, so the ceiling buys words rather than
markup and indentation. It is still an EXCERPT: a 200KB newsletter is not stored
twice, and the field's cap is the boundary of the carve-out.

**2. It is OPT-IN, per instance, and absent by default.**
`instanceSettings.isBodySearchIndexingEnabled` is unset on every existing and
every new deployment, and unset means the column is never written. An instance
that never visits the setting is byte-identical to the pre-idea-32 product: same
row shape, same index read, same results. The switch is admin-gated through the
one writer of the settings columns (`workspaces/settings.update`).

**3. The opt-OUT removes, it does not merely stop.** A true→false transition
schedules `mail/bodySearchBackfill.purgeSearchBodies`, a cursor-paginated sweep
that clears every excerpt already written and retires each mailbox's completed
index job. An operator who turns this off is asking for the plaintext to be
gone; a switch that only governed future mail would be a promise about the wrong
tense. The sweep re-reads the switch every page, so flipping it back on
mid-sweep stops the erasure rather than racing it.

**4. A SECOND search index, not a repointed one.** `search_messages` (on
`snippet`) stays exactly as it is; `search_message_bodies` (on `searchBody`) is
added beside it. Repointing the single index at `searchBody` would have dropped
every message delivered before the switch out of search until a backfill
finished — a silent narrowing, which is the same failure mode this ADR exists to
remove, merely inverted.

**5. The deeper index is read only when it is COMPLETE for that mailbox.**
`mail/searchBody.resolveBodySearchMode` returns `'body'` only when the instance
switch is on AND that mailbox's backfill job is `completed` with `mode: 'index'`.
Otherwise the read path stays on `snippet`. This is the same completeness gate
`filename:` already uses for the attachment index (`isAttachmentIndexComplete`),
and it enforces the floor that governs the whole feature: **search may become
deeper, never shallower**.

**6. A resumable backfill covers existing mail.** `mail/bodySearchBackfill` is a
per-mailbox job walking `mailMessages` one page at a time. It runs from an
**action** rather than a mutation, because a large body lives in a storage blob
and blob contents are unreadable from a query or a mutation: an internal query
reads and unseals the page's inline parts, the action resolves the blobs through
`readMailMessageText` (the single sanctioned blob reader), and an internal
mutation writes the excerpts and advances the cursor. Owner-grade, re-entrant,
idempotent, cancellable between pages.

**7. The UI states which depth it is actually at.** The search box carries a
quiet line — not a banner — whenever search is shallower than the feature's best:
the instance opted out, the walk is running, or this mailbox has never been
walked. A search that stops at character 200 says so, which is the specific
harm the 200-character ceiling caused.

## Consequences

- A database dump of an opted-in instance contains up to ~8KB of readable text
  per message instead of 200 characters. That is the trade, stated plainly; it
  is the operator's to make, and the product does not make it for them.
- The at-rest canary (`__tests__/sealBodiesAtRest.integration.test.ts`) asserts
  zero body plaintext across the inline columns and blobs, excluding the named
  search exception. `searchBody` joins `snippet` in that exclusion, and the
  exception list in the sealed-mail docs now names both.
- Storage grows by roughly the excerpt size per message on an opted-in instance,
  plus a second search index over the same table. On an instance that stays
  opted out, both are empty and cost nothing.
- The write path now reads `instanceSettings` once per delivered message. It is
  a singleton `first()` on a path that already performs several reads; the
  alternative — caching the flag — would let a disable go unhonoured for as long
  as the cache lived, which is precisely the guarantee that must not be soft.
- Four row-insert sites carry the field (inbound delivery, external IMAP sync,
  IMAP `APPEND`, and the Sent copy). A fifth added later without it would leave
  a hole the body index cannot report — a message findable only by its first 200
  characters on an instance that believes it searches whole bodies. `IMAP COPY`
  is safe by construction: it spreads the source row.
- An html-only message whose body was large enough to spill into a storage blob
  falls back to its snippet during the backfill, because the sanctioned blob
  reader covers the text part only. Less depth than we would like; never less
  than before. Delivery-time writes are unaffected — they see the full body
  before the inline/blob split.
- The `mode: 'index' | 'purge'` discriminator on the job row is load-bearing in
  both directions: only a completed INDEX job opens the deeper read, so a
  completed purge can never be mistaken for readiness.

## Non-goals

- Indexing the **whole** body. The cap is what keeps this a carve-out rather
  than a second, unsealed copy of the mailbox.
- Per-user or per-mailbox control. The trade is about what this deployment's
  database contains, which is an instance-level property; a per-user switch
  would imply a per-user promise the storage layer cannot keep.
- Attachment CONTENT search. Filenames are indexed (`search_filenames`);
  extracting and indexing document text is a different decision with a different
  threat model.
- Re-encrypting or otherwise protecting the search index itself. Convex indexes
  plaintext; a searchable-encryption scheme is not on the table here.
- Replacing idea 49's offline search. The two are complementary — offline search
  stays the no-tradeoff answer for cached mail on a device.
