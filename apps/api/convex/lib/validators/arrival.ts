/**
 * Validators for read on arrival (SPEC §2.9): the arrival record, the thread
 * projection and overrides, sender profiles, the undo log, delayed actions,
 * digests, and the fields the plan adds to existing rows (gist, source
 * accounting). The vocabularies come from `@owlat/shared/arrival`, so the
 * stored shape and the shared types cannot drift apart. A leaf module: the
 * schema loads it.
 *
 * Fields commented `sealed` hold an at-rest envelope written through
 * `lib/messageBody.ts` (`sealBodyAtWrite` / `openMessageBody`), the same seal
 * as `briefTop` and message bodies.
 */

import { v, type Infer } from 'convex/values';
import {
	ARRIVAL_OPERATION_ACTORS,
	ARRIVAL_OPERATION_KINDS,
	ARRIVAL_OPERATION_STATUSES,
	DEGRADED_BY,
	DEPTHS,
	DIGEST_KINDS,
	EXCLUSIVE_WINNER_SOURCES,
	FILTER_ORIGINS,
	PLACEMENTS,
	SENDER_PLACEMENT_OVERRIDES,
	SENDER_STATUS_SOURCES,
	SENDER_STATUSES,
} from '@owlat/shared/arrival';
import { literalUnion } from '../literalUnion';

export const placementValidator = literalUnion(PLACEMENTS);
export const depthValidator = literalUnion(DEPTHS);
export const senderStatusValidator = literalUnion(SENDER_STATUSES);
export const senderStatusSourceValidator = literalUnion(SENDER_STATUS_SOURCES);
export const senderPlacementOverrideValidator = literalUnion(SENDER_PLACEMENT_OVERRIDES);
export const degradedByValidator = literalUnion(DEGRADED_BY);
export const digestKindValidator = literalUnion(DIGEST_KINDS);
export const filterOriginValidator = literalUnion(FILTER_ORIGINS);
export const arrivalOperationKindValidator = literalUnion(ARRIVAL_OPERATION_KINDS);
export const arrivalOperationActorValidator = literalUnion(ARRIVAL_OPERATION_ACTORS);
export const arrivalOperationStatusValidator = literalUnion(ARRIVAL_OPERATION_STATUSES);

/** A machine reason plus params; the UI renders it from i18n. */
export const reasonKeyValidator = v.object({
	key: v.string(),
	params: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
});

// ── Arrival record ────────────────────────────────────────────────────────

/** One filter the arrival evaluation matched (§6.2), revision-bound. */
export const arrivalFilterMatchValidator = v.object({
	filterId: v.id('mailFilters'),
	revision: v.number(),
	pass: v.union(v.literal('deterministic'), v.literal('ai')),
	// The R2 answer for an `ai` pass; null = unknown or failed (no match).
	answer: v.optional(v.union(v.boolean(), v.null())),
});

/** An AI-conditioned filter whose deterministic part matched; waits for R2 (§6.2). */
export const pendingAiFilterValidator = v.object({
	filterId: v.id('mailFilters'),
	revision: v.number(),
	question: v.string(),
});

/** The writer that holds an exclusive action (§6.2 rule 5). */
export const exclusiveWinnerValidator = v.object({
	source: literalUnion(EXCLUSIVE_WINNER_SOURCES),
	filterId: v.optional(v.id('mailFilters')),
	// Lower runs first; sender status uses SENDER_STATUS_WINNER_PRIORITY.
	priority: v.number(),
	// Folder winners: the folder the winner's move put the message in. A later,
	// higher-priority AI answer may move the message only while it is still
	// there (lane rules, review r1 F3).
	folderId: v.optional(v.id('mailFolders')),
});

export const exclusiveWinnersValidator = v.object({
	folder: v.optional(exclusiveWinnerValidator),
	section: v.optional(exclusiveWinnerValidator),
	placement: v.optional(exclusiveWinnerValidator),
});

// ── Thread projection and overrides ───────────────────────────────────────

/** `mailThreads.arrival`: the derived placement of the newest inbound message (§2.8). */
export const threadArrivalValidator = v.object({
	placement: placementValidator,
	depth: v.optional(depthValidator),
	messageId: v.id('mailMessages'),
	sourceOrderKey: v.optional(v.string()),
	decidedAt: v.number(),
});

/** A thread-scope placement override, set by Fix (§4.2). */
export const placementOverrideValidator = v.object({
	placement: placementValidator,
	setAt: v.number(),
	operationId: v.id('mailArrivalOperations'),
});

export type PlacementOverrideRow = Infer<typeof placementOverrideValidator>;

// ── Sender profile ────────────────────────────────────────────────────────

/** The external unsubscribe request (§5); local suppression is the status. */
export const senderUnsubscribeValidator = v.object({
	method: v.union(v.literal('one_click'), v.literal('mailto'), v.literal('https')),
	requestedAt: v.number(),
	result: v.union(v.literal('confirmed'), v.literal('failed'), v.literal('opened')),
});

/** Human-origin unread archives (§4.3). `count: -1` is the "do not relearn" sentinel. */
export const unreadArchiveEvidenceValidator = v.object({
	count: v.number(),
	sessions: v.number(),
	lastSessionKey: v.optional(v.string()),
	version: v.literal(1),
});

// ── Undo log ──────────────────────────────────────────────────────────────

const senderStatusValueValidator = v.object({
	status: senderStatusValidator,
	statusSource: senderStatusSourceValidator,
});

const senderDraftPauseValueValidator = v.object({
	autoDraftPausedAt: v.optional(v.number()),
	unusedDraftStreak: v.number(),
});

/**
 * One changed entity (`mailArrivalOperationChanges.change`, §4.4), written in
 * the same mutation as the change. Mirrors `ArrivalOperationChange`.
 */
export const arrivalOperationChangeValidator = v.union(
	v.object({
		kind: v.literal('messageFolder'),
		messageId: v.id('mailMessages'),
		before: v.id('mailFolders'),
		after: v.id('mailFolders'),
	}),
	v.object({
		kind: v.literal('messageRead'),
		messageId: v.id('mailMessages'),
		before: v.boolean(),
		after: v.boolean(),
	}),
	v.object({
		kind: v.literal('threadPlacementOverride'),
		threadId: v.id('mailThreads'),
		before: v.union(placementOverrideValidator, v.null()),
		after: v.union(placementOverrideValidator, v.null()),
	}),
	v.object({
		kind: v.literal('senderStatus'),
		senderDigest: v.string(),
		before: senderStatusValueValidator,
		after: senderStatusValueValidator,
	}),
	v.object({
		kind: v.literal('senderPlacementOverride'),
		senderDigest: v.string(),
		before: v.union(senderPlacementOverrideValidator, v.null()),
		after: v.union(senderPlacementOverrideValidator, v.null()),
	}),
	v.object({
		kind: v.literal('senderDraftPause'),
		senderDigest: v.string(),
		before: senderDraftPauseValueValidator,
		after: senderDraftPauseValueValidator,
	}),
	v.object({
		kind: v.literal('messageLabel'),
		messageId: v.id('mailMessages'),
		labelId: v.id('mailLabels'),
		before: v.boolean(),
		after: v.boolean(),
	}),
	v.object({
		kind: v.literal('messageFlag'),
		messageId: v.id('mailMessages'),
		before: v.boolean(),
		after: v.boolean(),
	}),
	v.object({
		kind: v.literal('messageSection'),
		messageId: v.id('mailMessages'),
		before: v.union(v.string(), v.null()),
		after: v.union(v.string(), v.null()),
	}),
	v.object({
		kind: v.literal('recordRulePlacement'),
		messageId: v.id('mailMessages'),
		before: v.union(placementValidator, v.null()),
		after: v.union(placementValidator, v.null()),
	})
);

export type ArrivalOperationChangeRow = Infer<typeof arrivalOperationChangeValidator>;

// ── Rules: filter fields, delayed actions ─────────────────────────────────

/** `mailFilters.aiCondition` (§6.2): the question R2 answers, revision-bound. */
export const filterAiConditionValidator = v.object({
	question: v.string(),
	revision: v.number(),
});

/** The message state a delayed action was created against (§6.4). */
export const delayedActionAnchorValidator = v.object({
	messageReceivedAt: v.number(),
	messageSourceOrderKey: v.optional(v.string()),
	folderId: v.id('mailFolders'),
});

export const delayedActionStateValidator = v.union(
	v.literal('pending'),
	v.literal('done'),
	v.literal('cancelled')
);

export const delayedActionCancelReasonValidator = v.union(
	v.literal('reply'),
	v.literal('flag'),
	v.literal('moved'),
	v.literal('user'),
	v.literal('undo')
);

// ── Digest ────────────────────────────────────────────────────────────────

/** One rendered digest line (≤5 per kind, ≤15 in all, §6.5). Spans sealed. */
export const digestItemValidator = v.object({
	threadId: v.id('mailThreads'),
	messageId: v.id('mailMessages'),
	kind: digestKindValidator,
	// Verbatim-grounded quotes; absent = rendered by subject only.
	spans: v.optional(v.array(v.object({ quote: v.string() }))), // quote sealed
});

/** A thread the digest visited and consumes on send, with its boundary snapshot. */
export const digestVisitedValidator = v.object({
	threadId: v.id('mailThreads'),
	throughSourceOrderKey: v.string(),
	kind: digestKindValidator,
});

export const digestOverflowByKindValidator = v.object({
	newsletter: v.number(),
	updates: v.number(),
	promotion: v.number(),
});

export const digestStateValidator = v.union(
	v.literal('claimed'),
	v.literal('generated'),
	v.literal('sent'),
	v.literal('failed')
);

// ── Fields on existing rows ───────────────────────────────────────────────

/**
 * `threadBriefs.gist` (§2.4): 1–2 verbatim spans of one source message and an
 * optional fact, each quote sealed. Superseded by a later full read; hidden by
 * the stale fence; cleared by purge and scope conversion.
 */
export const threadBriefGistValidator = v.object({
	spans: v.array(
		v.object({
			// `ground.ts` segment id the quote matched in.
			segmentId: v.string(),
			quote: v.string(), // sealed
		})
	),
	fact: v.optional(v.object({ kind: v.string(), quote: v.string() })), // quote sealed
	sourceKey: v.string(),
	gistVersion: v.number(),
	generatedAt: v.number(),
});

/** `briefTop.gist`: the spans joined and trimmed for a list row. Sealed. */
export const briefTopGistValidator = v.object({
	text: v.string(), // sealed
	factQuote: v.optional(v.string()), // sealed
});

/** `interpretSources.readOutcome`: settled without a full read (§2.5). */
export const sourceReadOutcomeValidator = v.union(v.literal('gist'), v.literal('skipped'));
