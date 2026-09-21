import { ostrTierValidator } from '../ostr/signals';
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { inboundEncryptionInfoValidator } from '../e2ee/inboundSeal';
import { inboundSignatureInfoValidator } from '../e2ee/inboundSignature';
import { spamVerdictValidator } from '../lib/convexValidators';
import { virusVerdictValidator } from '../lib/literalValidators';
import {
	mailMessageAttachmentValidator,
	mailUnsubscribeValidator,
} from '../lib/mailContentValidators';
import { senderHeuristicsValidator } from '../lib/senderHeuristicsValidator';
import { folderRoleValidator } from '../mail/mailbox/shared';
import { mailEncryptionInfoValidator } from '../mail/sealPolicy';

/**
 * Folders and the message row itself.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailMessagesTables = {
	mailFolders: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		role: v.optional(folderRoleValidator),
		parentId: v.optional(v.id('mailFolders')),
		uidValidity: v.number(),
		uidNext: v.number(),
		highestModseq: v.number(),
		totalCount: v.number(),
		unseenCount: v.number(),
		subscribed: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_name', ['mailboxId', 'name'])
		.index('by_mailbox_and_role', ['mailboxId', 'role']),

	// Core mail message envelope. Body in ctx.storage as raw RFC822.

	mailMessages: defineTable({
		mailboxId: v.id('mailboxes'),
		folderId: v.id('mailFolders'),
		uid: v.number(),
		modseq: v.number(),

		// RFC 5322 envelope (parsed once at delivery)
		rfc822MessageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.array(v.string())),
		threadId: v.id('mailThreads'),

		fromAddress: v.string(),
		fromName: v.optional(v.string()),
		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		replyToAddress: v.optional(v.string()),
		subject: v.string(),
		normalizedSubject: v.string(),
		snippet: v.string(),
		// DEEP BODY SEARCH (idea 32) — a normalized ~8KB excerpt of the same body
		// `snippet` takes its first 200 characters from, indexed by
		// `search_message_bodies` below. WIDENS the sealed-at-rest plaintext
		// carve-out documented at that index, so it is written ONLY when the
		// instance opt-in `instanceSettings.isBodySearchIndexingEnabled` is on;
		// ABSENT is the default and is exactly the pre-idea-32 behaviour. Turning
		// the switch back off schedules a sweep that clears it again
		// (`mail/bodySearchBackfill.purgeSearchBodies`). See `mail/searchBody.ts`
		// and docs/adr/0059-widened-body-search-carve-out.md.
		searchBody: v.optional(v.string()),

		// Storage refs
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		textBodyStorageId: v.optional(v.id('_storage')),
		textBodyInline: v.optional(v.string()),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyInline: v.optional(v.string()),

		// Attachments (content stays inside the raw .eml; we only store metadata)
		attachments: v.array(mailMessageAttachmentValidator),
		hasAttachments: v.boolean(),

		// IMAP flags
		flagSeen: v.boolean(),
		flagFlagged: v.boolean(),
		flagAnswered: v.boolean(),
		flagDraft: v.boolean(),
		flagDeleted: v.boolean(),
		customFlags: v.array(v.string()),
		labelIds: v.array(v.id('mailLabels')),

		// When this message was moved INTO the trash (idea 67). Stamped by
		// `moveMessagesToFolder` on a trash destination and cleared on the way
		// out, so it always answers "how long has this been in the bin" — which
		// `receivedAt` cannot (a year-old message trashed today) and `updatedAt`
		// cannot either (any flag change moves it). Read only by the opt-in
		// trash auto-purge sweep; absent on every row trashed before the field
		// existed, and the sweep treats absent as "not yet dateable" rather than
		// as "old", so turning the setting on can never destroy mail whose age in
		// the bin is unknown.
		trashedAt: v.optional(v.number()),
		// Snooze (P8): hides the message from the inbox until the timestamp
		// passes; a 1-min cron sweep returns it (and bumps the thread
		// `lastMessageAt` so the inbox sort floats it back to the top).
		snoozedUntil: v.optional(v.number()),
		// Folder the message snoozed FROM, so the wakeup cron knows where
		// to put it back.
		snoozedFromFolderId: v.optional(v.id('mailFolders')),
		// "Snooze until they reply": when set alongside `snoozedUntil` (which
		// holds the fallback cap), ANY inbound reply into the thread clears the
		// snooze early (mail/delivery.ts hook, mirroring followUps) so the
		// conversation resurfaces the moment the awaited reply lands. If no reply
		// arrives, the normal snooze sweep resurfaces it once at the cap.
		isSnoozeUntilReply: v.optional(v.boolean()),

		// Split inbox (idea 24): the named inbox SECTION a `pinToSection` filter
		// filed this message into. Purely a reading arrangement — the row stays in
		// whatever folder it was delivered to, and a message with no section simply
		// renders in the trailing "Everything else" section, so absent = exactly
		// today's flat inbox. Stamped at delivery (deliveryPipeline/routing) and by
		// the retroactive sweep (mail/filterRun.ts); never read by IMAP.
		pinnedSection: v.optional(v.string()),

		// List mail: parsed List-Unsubscribe / List-Unsubscribe-Post target
		// (RFC 2369 / RFC 8058), extracted once at ingest from the raw header
		// block. Absent for non-list mail — the reader's Unsubscribe chip keys
		// off this field's presence.
		unsubscribe: v.optional(mailUnsubscribeValidator),

		// Delivery/security metadata
		receivedAt: v.number(),
		internalDate: v.number(),
		spamScore: v.optional(v.number()),
		spamVerdict: v.optional(spamVerdictValidator),
		virusVerdict: v.optional(virusVerdictValidator),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		// Published DMARC policy that applied to this message (`none`/`quarantine`/
		// `reject`). Recorded alongside `dmarcResult` so the Spam-routing decision
		// (a quarantine/reject fail → Spam) and the UI banner can distinguish a
		// monitor-only `p=none` fail from one the domain owner asked us to act on.
		dmarcPolicy: v.optional(v.string()),
		// DMARC alignment inputs captured alongside the verdicts above: the SMTP
		// envelope MAIL FROM domain (the SPF-authenticated identity) and the d=
		// domain of the passing DKIM signature. Kept so a later impersonation
		// heuristic can compare them against the visible From domain without
		// re-parsing the raw .eml. ALL optional — an older MTA sends them absent,
		// which renders as "unknown" (never asserts alignment we did not verify).
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
		// Inbound-authentication OVERRIDE applied at delivery (Sealed Mail A5). Set
		// to `'arc'` when a DMARC fail was RESCUED because a TRUSTED forwarder's
		// validated ARC chain (RFC 8617) attested the original passed — the message
		// then skipped Spam-routing. `arcSealer` records which forwarder's seal was
		// honoured (its `d=`), so the reader's badge can say "verified via forwarder"
		// and name it. Both absent on the overwhelmingly common non-forwarded path —
		// their presence is the ONLY thing that unlocks the badge's forwarder state,
		// so an ordinary message can never render it.
		dmarcOverride: v.optional(v.string()),
		arcSealer: v.optional(v.string()),
		ostrTier: v.optional(ostrTierValidator),
		// Sender-impersonation heuristics computed at ingest (Sealed Mail A4).
		// Two content-visible signals derived from the scanner rule (a From domain
		// that homoglyph/punycode-spoofs a real one, a Reply-To on a different
		// domain) plus two that need data the scanner cannot see (is this a
		// first-time sender to this mailbox, does the From domain look like a KNOWN
		// contact's). Surfaced by the reader's sender badge as secondary detail
		// lines — never a second badge. ALL optional and the whole object is
		// absent when nothing fired, so a legacy row / an unremarkable sender
		// renders no extra lines rather than a false "all clear".
		senderHeuristics: v.optional(senderHeuristicsValidator),

		// Team-inbox attribution: on an outbound message, the BetterAuth user id of
		// the teammate who fired the send (copied from the draft at dispatch). Lets
		// a shared inbox attribute "who replied" per message. Optional — inbound
		// mail and legacy sent rows carry no sender, and the from-address alone can
		// never distinguish two teammates sending as the same shared address.
		sentByUserId: v.optional(v.string()),

		// Outbound tracking (sent path). Per-recipient state lives in
		// `recipients[]`; `state` is a denormalized aggregate derived by
		// the Postbox outbound lifecycle module (the only writer). See
		// docs/adr/0012-postbox-outbound-lifecycle-module.md.
		outbound: v.optional(
			v.object({
				// AGGREGATED — derived from recipients[] by the lifecycle module.
				// `partial` is the only literal that exists here but not on a
				// per-recipient entry; it covers any mix of recipient states.
				state: v.union(
					v.literal('queued'),
					v.literal('sent'),
					v.literal('bounced'),
					v.literal('failed'),
					v.literal('partial')
				),
				recipients: v.array(
					v.object({
						// 0-based position in the deduplicated To+Cc+Bcc list at
						// dispatch time. Stable across the row's lifetime.
						idx: v.number(),
						// Recipient email — metadata; not unique on the row (To+Cc
						// can collide on the same address).
						address: v.string(),
						// Deterministic from `idx`: `pb-<mailMessageId>-<idx>`.
						mtaJobId: v.string(),
						state: v.union(
							v.literal('queued'),
							v.literal('sent'),
							v.literal('bounced'),
							v.literal('failed')
						),
						sentAt: v.optional(v.number()),
						// Remote-DATA acceptance is evidence independent of the
						// recipient's display state. It may predate a later terminal
						// event even when its webhook arrives afterward.
						acceptedAt: v.optional(v.number()),
						bouncedAt: v.optional(v.number()),
						failedAt: v.optional(v.number()),
						bounceMessage: v.optional(v.string()),
						errorCode: v.optional(v.string()),
					})
				),
			})
		),

		// Sealed Mail (E3): the outbound sealing outcome for a SENT copy. When
		// `isSealed` is true the raw `.eml` is PGP/MIME ciphertext (real subject
		// inside, `...` outside) and the fingerprints used are recorded; when
		// false a `reason` explains why the message went plaintext (e.g. a
		// recipient without a usable key — never a mixed send, per D2). Absent on
		// inbound rows and on outbound rows written before this field existed.
		encryptionInfo: v.optional(mailEncryptionInfoValidator),

		// Sealed Mail (E4): the INBOUND unsealing outcome for a DELIVERED message
		// (decrypt-on-ingest, D3). When present the message arrived as PGP/MIME
		// ciphertext; `isDecrypted:true` means we opened it (the row's body columns
		// hold the restored plaintext, the raw `.eml` at `rawStorageId` is the
		// retained sealed original) and `isSignatureValid` records whether the body's
		// signature verified against the pinned sender key; `isDecrypted:false` is the
		// "Encrypted — can't decrypt" path (we hold no usable key). Distinct from the
		// outbound `encryptionInfo` above — an inbound record describes what WE
		// verified on receipt, not what WE sealed. Absent on plaintext mail and on
		// rows written before this field existed.
		inboundEncryptionInfo: v.optional(inboundEncryptionInfoValidator),

		// Inbound PGP signature verification (F1, D9): the honest verdict for a
		// message that arrived SIGNED but not encrypted (RFC 3156 multipart/signed
		// or an inline clearsigned body), verified server-side at ingest against
		// the TOFU-pinned/WKD-discovered sender key. Deliberately a SIBLING of the
		// sealed record above, never a third arm on it — signed plaintext makes no
		// encryption claim. Absent on plaintext mail, on sealed mail (the sealed
		// record owns its own signature claim), and on rows written before this
		// field existed.
		inboundSignatureInfo: v.optional(inboundSignatureInfoValidator),

		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_folder_and_uid', ['folderId', 'uid'])
		// Smallest-UID unseen message per folder for IMAP `* OK [UNSEEN]` — an O(1)
		// indexed `first()` instead of collecting + sorting the whole folder.
		.index('by_folder_and_seen', ['folderId', 'flagSeen', 'uid'])
		.index('by_folder_and_modseq', ['folderId', 'modseq'])
		.index('by_mailbox_and_received', ['mailboxId', 'receivedAt'])
		// Receiver clock: sender-controlled Date headers must not alter observer volume.
		.index('by_mailbox_and_created', ['mailboxId', 'createdAt'])
		// Folder-scoped arrival order — backs the per-folder list page directly (no
		// mailbox-wide overfetch-then-filter that starved minority folders).
		.index('by_folder_and_received', ['folderId', 'receivedAt'])
		// Split inbox (idea 24) — ONE INDEX PER SECTION SLICE, which is what keeps
		// the sectioned renderer from starving a section. Paging a single mixed
		// feed and bucketing it client-side would let a chatty section eat the
		// whole page and leave a quiet one permanently empty; instead each section
		// walks its OWN arrival-ordered range with its OWN limit. The `by_seen`
		// sibling backs the per-section unread count as a bounded indexed take
		// rather than a scan of the section.
		.index('by_folder_and_section_and_received', ['folderId', 'pinnedSection', 'receivedAt'])
		.index('by_folder_and_section_and_seen', ['folderId', 'pinnedSection', 'flagSeen'])
		// Mailbox-scoped snooze range — backs the "Snoozed" view without scanning
		// the whole mailbox.
		// Trash auto-purge (idea 67): expired-first within one bin. `trashedAt` is
		// optional, so the sweep pins the range with `gte(0)` to exclude the rows
		// that carry no stamp at all.
		.index('by_folder_and_trashed', ['folderId', 'trashedAt'])
		.index('by_mailbox_and_snoozed', ['mailboxId', 'snoozedUntil'])
		.index('by_thread', ['threadId'])
		.index('by_rfc822_message_id', ['rfc822MessageId'])
		.index('by_mailbox_and_from', ['mailboxId', 'fromAddress'])
		.index('by_mailbox_and_unseen', ['mailboxId', 'flagSeen'])
		// Backs the 1-minute snooze sweep cron — range scan on snoozedUntil <= now.
		.index('by_snoozed_until', ['snoozedUntil'])
		// SHARING-AWARE SEAL (Sealed Mail E8b): IMAP COPY shares a storage blob
		// between rows (`mail/imap/move.ts` copyMessages spreads the same `rawStorageId`/
		// `*BodyStorageId` into the new row). The at-rest reseal must repoint EVERY
		// row that references an old plaintext blob before it deletes that blob, or a
		// sibling copy is left pointing at a deleted id (unreadable forever). These
		// indexes let the reseal find those siblings in O(matches) instead of a table
		// scan. `textBodyStorageId`/`htmlBodyStorageId` are optional; rows without
		// them index as `undefined` and are never matched by a concrete-id lookup.
		.index('by_raw_storage', ['rawStorageId'])
		.index('by_text_body_storage', ['textBodyStorageId'])
		.index('by_html_body_storage', ['htmlBodyStorageId'])
		// SEALED-AT-REST EXCEPTION (Sealed Mail E8b): the message BODY columns
		// (`textBodyInline`/`htmlBodyInline` and the `*BodyStorageId` blobs) are
		// sealed with the instance data key, but `snippet` stays PLAINTEXT because
		// Convex full-text search indexes the plaintext of `searchField`. This is
		// the documented, deliberate exception — `snippet` is a short excerpt, never
		// the full body, and losing it would break server-side mail search. See
		// lib/atRestBodies.ts and apps/docs/content/en/3.developer/21.sealed-mail-at-rest.md.
		.searchIndex('search_messages', {
			searchField: 'snippet',
			filterFields: ['mailboxId', 'folderId', 'fromAddress', 'flagSeen', 'flagFlagged'],
		})
		// THE WIDENED CARVE-OUT (idea 32, ADR-0059). Same exception as above, one
		// order of magnitude deeper: `searchBody` is a ~8KB normalized excerpt
		// instead of a 200-character one, so a phrase at character 1,400 of a
		// contract is findable instead of silently absent. Because that is a real
		// change in what a database dump reveals, the column is written ONLY on an
		// instance that opted in (`instanceSettings.isBodySearchIndexingEnabled`);
		// everywhere else it is absent and this index is empty, which costs
		// nothing and matches the snippet-only behaviour exactly.
		//
		// A SECOND INDEX, NOT A REPOINTED ONE: repointing `search_messages` at
		// `searchBody` would drop every message delivered before the switch out of
		// search until a backfill finished. The read path (`mail/searchBody.ts`
		// `resolveBodySearchMode`) picks this index only once the per-mailbox
		// backfill reports `completed`, so search never narrows behind the user's
		// back.
		.searchIndex('search_message_bodies', {
			searchField: 'searchBody',
			filterFields: ['mailboxId', 'folderId', 'fromAddress', 'flagSeen', 'flagFlagged'],
		}),

	// Conversation grouping across folders. Aggregates updated by mutations.
};
