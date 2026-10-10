/**
 * What the thread brief reads return (SPEC §4 `brief.ts`, §7): the
 * `returns` validators of `mail/interpret/brief.ts get({threadRef, locale})`
 * and of the team stream, plus their TS types, so the web can be written
 * against them before the queries exist.
 *
 * Everything here is already unsealed and localized for the caller: `text` is
 * the display string in the requested locale, never an envelope. Ids are
 * typed; the web imports the types with
 * `import type { ThreadBriefView } from '../../../api/convex/mail/interpret/briefShape'`
 * (the `contactActivities/types.ts` pattern) and the vocabularies from
 * `@owlat/shared/threadBrief`.
 *
 * Isolate-safe: validators and types only.
 */

import { v, type Infer } from 'convex/values';
import {
	activityActorValidator,
	activityDeltaValidator,
	activityOpRefValidator,
	activityProvenanceValidator,
	activityTypeValidator,
	activityVisibilityValidator,
	briefCompletenessValidator,
	factStatusValidator,
	interpretationSourceValidator,
	itemAmountValidator,
	itemCompletionValidator,
	itemConsequenceKindValidator,
	itemCorrectionKindValidator,
	itemDispositionValidator,
	itemDueValidator,
	itemFacetValidator,
	itemIntentValidator,
	itemReactionValidator,
	itemResponsibilityValidator,
	itemStateKeyValidator,
	itemStatusValidator,
	itemVerifyValidator,
	participantRefValidator,
	streamPositionValidator,
	threadViewValidator,
} from '../../lib/validators/threadBrief';
import { threadRefValidator } from '../../lib/validators/threadRef';

// ── Pieces ─────────────────────────────────────────────────────────────────

/** One quote marker: where in which message the claim comes from (cite → Conversation). */
export const evidenceViewValidator = v.object({
	source: interpretationSourceValidator,
	segmentId: v.string(),
	start: v.number(),
	end: v.number(),
	contentRevision: v.string(),
	// The quoted words, for the marker's tooltip.
	quote: v.optional(v.string()),
	// Which occurrence of the normalized quote in the message this is (0 = first),
	// and how many matches the interpreted (visible) text holds in all.
	occurrence: v.optional(v.number()),
	occurrenceCount: v.optional(v.number()),
});

/** One item as the brief shows it. */
export const briefItemViewValidator = v.object({
	id: v.id('threadItems'),
	revision: v.number(),
	intent: itemIntentValidator,
	facets: v.array(itemFacetValidator),
	consequences: v.optional(v.array(itemConsequenceKindValidator)),
	responsibility: itemResponsibilityValidator,
	status: itemStatusValidator,
	disposition: itemDispositionValidator,
	completion: v.optional(itemCompletionValidator),
	// itemStateKey() without draft coverage; the composer overlays addressedInDraft.
	stateKey: itemStateKeyValidator,
	primaryReaction: itemReactionValidator,
	// Display text in the requested locale.
	text: v.string(),
	requester: participantRefValidator,
	responsible: participantRefValidator,
	beneficiary: v.optional(participantRefValidator),
	assigneeUserId: v.optional(v.string()),
	due: v.optional(itemDueValidator),
	amount: v.optional(itemAmountValidator),
	options: v.optional(v.array(v.string())),
	evidence: v.array(evidenceViewValidator),
	// `proposal` = "Check this": not tracked until confirmed.
	verify: itemVerifyValidator,
	isReviewNeeded: v.boolean(),
	correction: v.optional(v.object({ kind: itemCorrectionKindValidator, at: v.number() })),
	remindAt: v.optional(v.number()),
	replacedById: v.optional(v.id('threadItems')),
	possibleDuplicateOfId: v.optional(v.id('threadItems')),
	commitmentId: v.optional(v.id('mailCommitments')),
	// An unconfirmed claim's changes to this tracked item ("Check this change"):
	// not applied until verified or confirmed.
	pendingUpdate: v.optional(
		v.object({
			evidence: v.array(evidenceViewValidator),
			due: v.optional(itemDueValidator),
			amount: v.optional(itemAmountValidator),
			options: v.optional(v.array(v.string())),
			// A confirmed item's re-read wording, in the requested locale.
			text: v.optional(v.string()),
			requester: v.optional(participantRefValidator),
			responsible: v.optional(participantRefValidator),
			beneficiary: v.optional(participantRefValidator),
			responsibility: v.optional(itemResponsibilityValidator),
			// Values the newer reading no longer has.
			removes: v.optional(
				v.array(v.union(v.literal('due'), v.literal('amount'), v.literal('options')))
			),
			// "A later message may have settled this": matched by wording only.
			transitions: v.optional(
				v.array(
					v.object({
						to: v.optional(itemStatusValidator),
						disposition: v.optional(itemDispositionValidator),
						at: v.number(),
					})
				)
			),
		})
	),
	askedAt: v.number(),
	updatedAt: v.number(),
	// Changed since the viewer last looked.
	isNew: v.boolean(),
});

/** One "Latest update" line (brief mode, mail threads only). */
export const latestLineViewValidator = v.object({
	text: v.string(),
	evidence: v.array(evidenceViewValidator),
});

/** One "Where things stand" fact. */
export const factViewValidator = v.object({
	id: v.id('threadFacts'),
	key: v.string(),
	text: v.string(),
	value: v.optional(
		v.union(
			v.object({ kind: v.literal('date'), at: v.number(), tz: v.optional(v.string()) }),
			v.object({ kind: v.literal('money'), value: v.number(), currency: v.string() }),
			v.object({
				kind: v.union(v.literal('ref'), v.literal('url'), v.literal('text')),
				text: v.string(),
			})
		)
	),
	status: factStatusValidator,
	provenance: activityProvenanceValidator,
	evidence: v.array(evidenceViewValidator),
	supersedesId: v.optional(v.id('threadFacts')),
	conflictsWithId: v.optional(v.id('threadFacts')),
});

/** One activity row. `text` is the rendered detail from the sealed payload, when it has one. */
export const activityViewValidator = v.object({
	id: v.id('threadActivity'),
	seq: v.number(),
	type: activityTypeValidator,
	actor: activityActorValidator,
	provenance: activityProvenanceValidator,
	visibility: activityVisibilityValidator,
	itemId: v.optional(v.id('threadItems')),
	itemRevision: v.optional(v.number()),
	delta: v.optional(activityDeltaValidator),
	opRef: v.optional(activityOpRefValidator),
	text: v.optional(v.string()),
	eventAt: v.number(),
});

export const participantViewValidator = v.object({
	email: v.optional(v.string()),
	name: v.optional(v.string()),
	isUs: v.boolean(),
	role: v.union(v.literal('from'), v.literal('to'), v.literal('cc'), v.literal('us')),
});

/** A file that went through the thread, in or out. */
export const fileViewValidator = v.object({
	attachmentId: v.string(),
	filename: v.string(),
	mimeType: v.optional(v.string()),
	size: v.optional(v.number()),
	messageId: v.string(),
	direction: v.union(v.literal('in'), v.literal('out')),
	at: v.number(),
});

export const sinceLastSeenViewValidator = v.object({
	newItemIds: v.array(v.id('threadItems')),
	changedItemIds: v.array(v.id('threadItems')),
	newActivityCount: v.number(),
});

export const briefCountsViewValidator = v.object({
	forYou: v.number(),
	forTeam: v.number(),
	waitingOnOthers: v.number(),
	unclear: v.number(),
	// Closed (done, declined, replaced) items still listed.
	closed: v.number(),
	// Not tracked: behind "Show hidden".
	hidden: v.number(),
});

/** Why the brief is incomplete or empty (`BriefIncomplete` banner). */
export const briefGapViewValidator = v.object({
	interpretedMessages: v.number(),
	totalMessages: v.number(),
	reason: v.optional(
		v.union(
			v.literal('pending'),
			v.literal('failed'),
			// Earlier history that cannot be read back (a team reply sent before snapshots).
			v.literal('history'),
			v.literal('tooLong'),
			v.literal('aiOff'),
			v.literal('undecryptable'),
			v.literal('ineligible'),
			v.literal('security'),
			v.literal('short')
		)
	),
});

// ── The brief ──────────────────────────────────────────────────────────────

const sharedViewFields = {
	threadRef: threadRefValidator,
	interpretationRevision: v.number(),
	completeness: briefCompletenessValidator,
	gap: v.optional(briefGapViewValidator),
	// Earlier history still being read: `running` while its chain moves,
	// `stalled` when it stopped (spend gate, AI off, a lost chain); the reader
	// asks `lazy.ensure` to resume a stalled one.
	history: v.optional(v.union(v.literal('running'), v.literal('stalled'))),
	waitingOnOthers: v.array(briefItemViewValidator),
	unclear: v.array(briefItemViewValidator),
	// Latest 5 substance rows, newest first.
	activity: v.array(activityViewValidator),
	counts: briefCountsViewValidator,
	// Item paging (`get({cursor})`): the open items come a page at a time; the
	// recently closed ones on the first page only. Never silently cut: a
	// further page has a cursor, a cut closed list says so.
	page: v.optional(
		v.object({
			cursor: v.union(v.string(), v.null()),
			isDone: v.boolean(),
			isClosedTruncated: v.boolean(),
		})
	),
};

/** Personal Postbox thread (brief mode). */
export const briefModeViewValidator = v.object({
	mode: v.literal('brief'),
	...sharedViewFields,
	// Absent for short mail, security mail, or before the first interpretation.
	latest: v.optional(v.array(latestLineViewValidator)),
	standing: v.optional(
		v.object({
			facts: v.array(factViewValidator),
			isConflicted: v.boolean(),
			// Compaction overview, when the cache holds one for this locale.
			overview: v.optional(v.string()),
		})
	),
	// Ordered by compareForYou.
	forYou: v.array(briefItemViewValidator),
	participants: v.array(participantViewValidator),
	files: v.array(fileViewValidator),
	sinceLastSeen: v.optional(sinceLastSeenViewValidator),
	// The viewer's per-thread choice (`threadViewerState.viewOverride`); the
	// web resolves the opening view from it and the saved default.
	viewOverride: v.optional(threadViewValidator),
	// Per interpreted message (mailMessages id), its own first "Latest update"
	// sentence in the requested locale: the collapsed rows of Conversation
	// show it instead of the raw snippet.
	messageLatest: v.optional(v.array(v.object({ messageId: v.string(), text: v.string() }))),
	// Messages (mailMessages ids) whose original the reader keeps open beside
	// the brief ("Read the exact wording"): legal notices, changed terms,
	// payment details. Security mail is shown as written instead (gap reason).
	exactWording: v.optional(
		v.array(
			v.object({
				messageId: v.string(),
				reason: v.optional(
					v.union(
						v.literal('legal'),
						v.literal('terms'),
						v.literal('payment_details'),
						v.literal('security')
					)
				),
			})
		)
	),
	// More such messages than one read lists: the reader says so.
	isExactWordingTruncated: v.optional(v.boolean()),
});

/** Team surfaces (actions mode): the "Open for the team" strip's data. */
export const actionsModeViewValidator = v.object({
	mode: v.literal('actions'),
	...sharedViewFields,
	// Ordered by compareForYou.
	forTeam: v.array(briefItemViewValidator),
});

/** `brief.get({threadRef, locale})` returns this (`completeness: 'none'` before any interpretation). */
export const threadBriefViewValidator = v.union(briefModeViewValidator, actionsModeViewValidator);

export type ThreadBriefView = Infer<typeof threadBriefViewValidator>;
export type BriefModeView = Infer<typeof briefModeViewValidator>;
export type TeamOpenItemsView = Infer<typeof actionsModeViewValidator>;
export type BriefItemView = Infer<typeof briefItemViewValidator>;
export type LatestLineView = Infer<typeof latestLineViewValidator>;
export type FactView = Infer<typeof factViewValidator>;
export type ActivityView = Infer<typeof activityViewValidator>;
export type EvidenceView = Infer<typeof evidenceViewValidator>;
export type ParticipantView = Infer<typeof participantViewValidator>;
export type FileView = Infer<typeof fileViewValidator>;

// ── The team stream ────────────────────────────────────────────────────────

/** Reactions on an internal note (chat reaction mechanism). */
export const noteReactionViewValidator = v.object({
	emoji: v.string(),
	count: v.number(),
	isMine: v.boolean(),
});

/**
 * One entry of the team thread stream. Order: `at`, then `tie`, then `key`
 * (`teamStreamMerge.ts`); `key` is stable across pages (`<kind>:<id>`).
 * Internal notes never leave this stream.
 */
export const teamStreamEntryValidator = v.union(
	v.object({
		kind: v.literal('customerEmail'),
		key: v.string(),
		at: v.number(),
		// The row's `_creationTime`: the index order among equal `at`.
		tie: v.number(),
		source: interpretationSourceValidator,
		fromName: v.optional(v.string()),
		fromEmail: v.optional(v.string()),
		subject: v.optional(v.string()),
		// Raw text preview of the original (never an AI summary).
		preview: v.string(),
	}),
	v.object({
		kind: v.literal('teamReply'),
		key: v.string(),
		at: v.number(),
		// The row's `_creationTime`: the index order among equal `at`.
		tie: v.number(),
		// The interpretation source of the reply. Absent for a follow-up that has
		// no Send yet (still in its undo window) and for a reply sent before
		// Sends existed.
		source: v.optional(interpretationSourceValidator),
		authorUserId: v.optional(v.string()),
		isAgent: v.boolean(),
		status: v.union(
			v.literal('queued'),
			v.literal('held'),
			v.literal('sent'),
			v.literal('failed'),
			v.literal('cancelled')
		),
		toName: v.optional(v.string()),
		preview: v.string(),
		// The whole text as it went out (Team Inbox: the immutable send snapshot,
		// or the follow-up's text). Shared mailboxes render the message itself.
		body: v.optional(v.string()),
		// The customer email it answers (inboundMessages / mailMessages id).
		inReplyToId: v.optional(v.string()),
		// A Team Inbox follow-up: its row, its Undo deadline and its failure.
		followUpId: v.optional(v.id('inboxFollowUps')),
		sendAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	}),
	v.object({
		kind: v.literal('note'),
		key: v.string(),
		at: v.number(),
		// The row's `_creationTime`: the index order among equal `at`.
		tie: v.number(),
		// `threadNote` (agent Team Inbox) or `chatMessage` (shared mailbox discussion).
		noteSource: v.union(v.literal('threadNote'), v.literal('chatMessage')),
		noteId: v.string(),
		authorId: v.string(),
		authorName: v.optional(v.string()),
		authorEmail: v.optional(v.string()),
		authorImage: v.optional(v.string()),
		body: v.string(),
		mentionedUserIds: v.array(v.string()),
		threadItemId: v.optional(v.id('threadItems')),
		// The linked item's text in the requested locale ("note on Refund €129.00").
		threadItemText: v.optional(v.string()),
		editedAt: v.optional(v.number()),
		isDeleted: v.boolean(),
		reactions: v.array(noteReactionViewValidator),
	}),
	v.object({
		kind: v.literal('activity'),
		key: v.string(),
		at: v.number(),
		// The row's `_creationTime`: the index order among equal `at`.
		tie: v.number(),
		activity: activityViewValidator,
		// The item the row is about, in the requested locale.
		itemText: v.optional(v.string()),
	})
);

/** One page of the stream, newest page first; `cursor` is opaque. */
export const teamStreamPageValidator = v.object({
	entries: v.array(teamStreamEntryValidator),
	cursor: v.union(v.string(), v.null()),
	isDone: v.boolean(),
	// The viewer's saved position, for "new since you looked".
	seenPosition: v.optional(streamPositionValidator),
});

export type TeamStreamEntry = Infer<typeof teamStreamEntryValidator>;
export type TeamStreamPage = Infer<typeof teamStreamPageValidator>;
