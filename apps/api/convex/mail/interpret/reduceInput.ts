/**
 * What the reducer (`reduce.ts applyInterpretation`) takes: one message's
 * interpretation after grounding and verification, normalized by the run.
 *
 * By the time a proposal reaches here:
 *   - every quote was resolved to offsets (`evidence`), and a claim with a
 *     failed quote was dropped by grounding;
 *   - participant refs (`p1` …) were resolved to `ParticipantRef`s;
 *   - due dates are epoch milliseconds;
 *   - `verify` / `isVerified` carry the verifier's verdict, and
 *     `isReviewNeeded` the screening flags.
 * Model ids (`matchItemId`, `itemId`, `matchFactId`, `supersedes`,
 * `conflictsWith`) are still plain strings: the reducer checks each against the
 * thread before it trusts it.
 *
 * Text here is plaintext; the reducer seals it on write. Isolate-safe.
 */

import { v, type Infer } from 'convex/values';
import {
	interpretCoverageValidator,
	interpretEligibilitySignalsValidator,
	interpretModeValidator,
	interpretationSkipReasonValidator,
	interpretationSourceValidator,
	interpretationStatusValidator,
	itemAmountValidator,
	itemConsequenceKindValidator,
	itemDispositionValidator,
	itemDueValidator,
	itemFacetValidator,
	itemIntentValidator,
	itemStatusValidator,
	itemVerifyValidator,
	participantRefValidator,
	sourceManifestValidator,
} from '../../lib/validators/threadBrief';
import { threadRefValidator } from '../../lib/validators/threadRef';

/** A grounded quote: where it sits in the segmented message, and its words. */
export const reduceEvidenceValidator = v.object({
	segmentId: v.string(),
	start: v.number(),
	end: v.number(),
	quote: v.string(),
	// Which occurrence of the (normalized) quote in the canonical text this is,
	// and how many there are in all.
	occurrence: v.optional(v.number()),
	occurrenceCount: v.optional(v.number()),
});

/** Brief mode: keep this message's original open beside the brief, and why. */
export const exactWordingResultValidator = v.object({
	reason: v.optional(
		v.union(
			v.literal('legal'),
			v.literal('terms'),
			v.literal('payment_details'),
			v.literal('security')
		)
	),
});

const localizedTextValidator = v.object({ en: v.string(), de: v.string() });

export const reduceItemValidator = v.object({
	matchItemId: v.optional(v.string()),
	intent: itemIntentValidator,
	facets: v.array(itemFacetValidator),
	// Absent = the model did not say (counts as consequential).
	consequences: v.optional(v.array(itemConsequenceKindValidator)),
	assertion: v.string(),
	display: localizedTextValidator,
	requester: participantRefValidator,
	// No email, no name and not us = unclear.
	responsible: participantRefValidator,
	beneficiary: v.optional(participantRefValidator),
	due: v.optional(itemDueValidator),
	amount: v.optional(itemAmountValidator),
	options: v.optional(v.array(v.string())),
	evidence: v.array(reduceEvidenceValidator),
	// passed: verified (or not consequential); proposal: plausible but unverified ("Check this").
	verify: itemVerifyValidator,
	isReviewNeeded: v.boolean(),
});

export const reduceTransitionValidator = v.object({
	// Absent: an obligation not seen yet, described by `about` (kept pending).
	itemId: v.optional(v.string()),
	about: v.optional(v.string()),
	to: v.optional(itemStatusValidator),
	disposition: v.optional(itemDispositionValidator),
	evidence: v.array(reduceEvidenceValidator),
	// The verifier confirmed the message states it (required for closing transitions).
	isVerified: v.boolean(),
	isReviewNeeded: v.boolean(),
});

export const reduceFactValueValidator = v.union(
	v.object({ kind: v.literal('date'), at: v.number(), tz: v.optional(v.string()) }),
	v.object({ kind: v.literal('money'), value: v.number(), currency: v.string() }),
	v.object({
		kind: v.union(v.literal('ref'), v.literal('url'), v.literal('text')),
		text: v.string(),
	})
);

export const reduceFactValidator = v.object({
	matchFactId: v.optional(v.string()),
	// factKeyString({entity, attribute, context}).
	key: v.string(),
	assertion: v.string(),
	display: localizedTextValidator,
	value: v.optional(reduceFactValueValidator),
	evidence: v.array(reduceEvidenceValidator),
	supersedes: v.optional(v.string()),
	conflictsWith: v.optional(v.string()),
	// The verifier confirmed a supersession (required to retire the old fact).
	isVerified: v.boolean(),
	isReviewNeeded: v.boolean(),
});

export const reduceLatestLineValidator = v.object({
	text: v.string(),
	evidence: v.array(reduceEvidenceValidator),
	isReviewNeeded: v.boolean(),
});

/** Why a brief-mode run has no "Latest update" although it read the message. */
export const latestSuppressionValidator = v.union(v.literal('short'), v.literal('security'));

/** The grounded, verified result of one message. */
export const reduceResultValidator = v.object({
	items: v.array(reduceItemValidator),
	transitions: v.array(reduceTransitionValidator),
	// Brief mode only.
	latest: v.optional(
		v.object({ en: v.array(reduceLatestLineValidator), de: v.array(reduceLatestLineValidator) })
	),
	latestSuppressed: v.optional(latestSuppressionValidator),
	facts: v.optional(v.array(reduceFactValidator)),
	// Brief mode, set only when the model asked for the exact wording.
	exactWording: v.optional(exactWordingResultValidator),
	// The Postbox needs-reply projection inputs (stored for replay).
	replyIntent: v.string(),
	urgency: v.union(v.literal('high'), v.literal('normal'), v.literal('low')),
	meetingIntent: v.optional(
		v.object({
			isScheduling: v.boolean(),
			proposedTimes: v.array(v.string()),
			topic: v.optional(v.string()),
		})
	),
	// What grounding and verification threw away (counts only, never text).
	dropped: v.object({ grounding: v.number(), verify: v.number() }),
});

export const applyInterpretationArgs = {
	source: interpretationSourceValidator,
	threadRef: threadRefValidator,
	mode: interpretModeValidator,
	contentRevision: v.string(),
	extractorVersion: v.number(),
	// threadBriefs.interpretationRevision the run loaded (compare-and-set).
	expectedRevision: v.number(),
	// threadBriefs.deletionEpoch the run loaded; a purge in between drops the write.
	deletionEpoch: v.number(),
	sourceAt: v.number(),
	direction: v.union(v.literal('inbound'), v.literal('outbound')),
	status: interpretationStatusValidator,
	skipReason: v.optional(interpretationSkipReasonValidator),
	errorCode: v.optional(v.string()),
	eligibility: v.optional(interpretEligibilitySignalsValidator),
	sourceManifest: v.optional(sourceManifestValidator),
	coverage: v.optional(interpretCoverageValidator),
	result: v.optional(reduceResultValidator),
	// Team thread assignee at load time: the default item assignee (D4).
	threadAssigneeUserId: v.optional(v.string()),
	// Fingerprint of the body the run read (sourceVersion.ts); rechecked here.
	sourceVersion: v.optional(v.string()),
	// Set on a repair attempt of an incomplete extraction (retry.ts).
	retryCount: v.optional(v.number()),
};

export type ReduceEvidence = Infer<typeof reduceEvidenceValidator>;
export type ReduceItem = Infer<typeof reduceItemValidator>;
export type ReduceTransition = Infer<typeof reduceTransitionValidator>;
export type ReduceFact = Infer<typeof reduceFactValidator>;
export type ReduceResult = Infer<typeof reduceResultValidator>;
export type ReduceLatestLine = Infer<typeof reduceLatestLineValidator>;
