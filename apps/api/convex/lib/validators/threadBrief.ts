/**
 * Convex validators of the thread brief (SPEC §2): items, facts, activity,
 * evidence, participants, response plans. Every literal union derives from the
 * tuples in `@owlat/shared/threadBrief`, so the schema, the functions and the
 * web read one vocabulary.
 *
 * SEALED strings. A field commented `sealed` holds an at-rest envelope
 * (`lib/atRestBodies.ts`, written through `lib/messageBody.ts` like a body):
 * text derived from mail is body text, so a database dump shows no plaintext
 * summary of a sealed message. Readers open it with `openMessageBody`.
 */

import { v, type Infer } from 'convex/values';
import {
	ACTIVITY_ACTORS,
	ACTIVITY_OP_REF_KINDS,
	ACTIVITY_PROVENANCES,
	ACTIVITY_TYPES,
	ACTIVITY_VISIBILITIES,
	BRIEF_COMPLETENESS,
	COVERAGE_VERDICTS,
	DRAFT_REF_KINDS,
	FACT_STATUSES,
	INTERPRET_MODES,
	INTERPRETATION_SKIP_REASONS,
	INTERPRETATION_STATUSES,
	ITEM_COMPLETIONS,
	ITEM_CONSEQUENCE_KINDS,
	ITEM_CORRECTION_KINDS,
	ITEM_DISPOSITIONS,
	ITEM_FACETS,
	ITEM_INTENTS,
	ITEM_REACTIONS,
	ITEM_RESPONSIBILITIES,
	ITEM_STATE_KEYS,
	ITEM_STATUSES,
	ITEM_VERIFY_STATES,
	MESSAGE_SEGMENT_KINDS,
	PLAN_VERDICTS,
	RESPONSE_STANCES,
	THREAD_VIEWS,
} from '@owlat/shared/threadBrief';
import type { Id } from '../../_generated/dataModel';
import { literalUnion } from '../literalUnion';

// ── Literal unions ─────────────────────────────────────────────────────────

export const interpretModeValidator = literalUnion(INTERPRET_MODES);
export const threadViewValidator = literalUnion(THREAD_VIEWS);
export const itemIntentValidator = literalUnion(ITEM_INTENTS);
export const itemFacetValidator = literalUnion(ITEM_FACETS);
export const itemResponsibilityValidator = literalUnion(ITEM_RESPONSIBILITIES);
export const itemStatusValidator = literalUnion(ITEM_STATUSES);
export const itemDispositionValidator = literalUnion(ITEM_DISPOSITIONS);
export const itemCompletionValidator = literalUnion(ITEM_COMPLETIONS);
export const itemConsequenceKindValidator = literalUnion(ITEM_CONSEQUENCE_KINDS);
export const itemVerifyValidator = literalUnion(ITEM_VERIFY_STATES);
export const itemCorrectionKindValidator = literalUnion(ITEM_CORRECTION_KINDS);
export const itemStateKeyValidator = literalUnion(ITEM_STATE_KEYS);
export const itemReactionValidator = literalUnion(ITEM_REACTIONS);
export const responseStanceValidator = literalUnion(RESPONSE_STANCES);
export const coverageVerdictValidator = literalUnion(COVERAGE_VERDICTS);
export const planVerdictValidator = literalUnion(PLAN_VERDICTS);
export const draftRefKindValidator = literalUnion(DRAFT_REF_KINDS);
export const factStatusValidator = literalUnion(FACT_STATUSES);
export const activityTypeValidator = literalUnion(ACTIVITY_TYPES);
export const activityActorKindValidator = literalUnion(ACTIVITY_ACTORS);
export const activityProvenanceValidator = literalUnion(ACTIVITY_PROVENANCES);
export const activityVisibilityValidator = literalUnion(ACTIVITY_VISIBILITIES);
export const activityOpRefKindValidator = literalUnion(ACTIVITY_OP_REF_KINDS);
export const interpretationStatusValidator = literalUnion(INTERPRETATION_STATUSES);
export const interpretationSkipReasonValidator = literalUnion(INTERPRETATION_SKIP_REASONS);
export const briefCompletenessValidator = literalUnion(BRIEF_COMPLETENESS);
export const messageSegmentKindValidator = literalUnion(MESSAGE_SEGMENT_KINDS);

// ── Sources and evidence ───────────────────────────────────────────────────

/**
 * The message an interpretation (and every claim it supports) was read from:
 * an inbound Postbox message, a team inbound message, a sent Postbox message
 * (the `mailMessages` row with `outbound`), or a finalized team send.
 */
export const interpretationSourceValidator = v.union(
	v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
	v.object({ kind: v.literal('inbound'), id: v.id('inboundMessages') }),
	v.object({ kind: v.literal('outboundMail'), id: v.id('mailMessages') }),
	v.object({ kind: v.literal('teamReply'), id: v.id('transactionalSends') })
);
export type InterpretationSource = Infer<typeof interpretationSourceValidator>;

/** `<kind>:<id>`, the indexed form of a source (`messageInterpretations.sourceKey`). */
export function interpretationSourceKey(source: InterpretationSource): string {
	return `${source.kind}:${source.id}`;
}

/**
 * One quote supporting a claim, resolved by grounding to offsets in the named
 * segment's canonical text at `contentRevision`.
 */
export const evidenceValidator = v.object({
	source: interpretationSourceValidator,
	segmentId: v.string(),
	start: v.number(),
	end: v.number(),
	contentRevision: v.string(),
	// The quoted words, for the brief's evidence marker and the next prompt's
	// excerpt (the source body is not re-read for either). Sealed.
	quote: v.optional(v.string()),
	// Which occurrence of the normalized quote in the canonical text this is
	// (0 = the first), so the reader marks this passage and not an earlier
	// one with the same words. Absent on evidence stored before it existed.
	occurrence: v.optional(v.number()),
});
export type Evidence = Infer<typeof evidenceValidator>;

/** One segment of the interpreted message (`segmentMessage` output, offsets only). */
export const sourceManifestSegmentValidator = v.object({
	id: v.string(),
	kind: messageSegmentKindValidator,
	start: v.number(),
	end: v.number(),
});

/** The segmentation an interpretation ran against; evidence offsets index into it. */
export const sourceManifestValidator = v.object({
	segments: v.array(sourceManifestSegmentValidator),
	// Whether segmentation itself was unsure (inline replies it could not split).
	isUncertain: v.boolean(),
});

/** What the model said it read (`coverage` of the output). */
export const interpretCoverageValidator = v.object({
	segmentsRead: v.array(v.string()),
	isUncertain: v.boolean(),
	isOverflow: v.boolean(),
});

// ── Item parts ─────────────────────────────────────────────────────────────

/** A party to an item. `isUs` = the mailbox owner / the team. */
export const participantRefValidator = v.object({
	email: v.optional(v.string()),
	name: v.optional(v.string()),
	isUs: v.boolean(),
});
export type ParticipantRef = Infer<typeof participantRefValidator>;

/** A due date as written, plus what it resolved to. */
export const itemDueValidator = v.object({
	// The phrase as written ("by Friday", "before the launch").
	phrase: v.string(),
	// Resolved deadline (ms epoch); absent when it could not be resolved.
	at: v.optional(v.number()),
	// IANA time zone `at` was resolved in.
	tz: v.optional(v.string()),
	isAmbiguous: v.boolean(),
	// A condition the deadline hangs on ("unless you object by 1 Nov").
	condition: v.optional(v.string()),
});
export type ItemDue = Infer<typeof itemDueValidator>;

/** A money amount: decimal value plus ISO 4217 currency. */
export const itemAmountValidator = v.object({
	value: v.number(),
	currency: v.string(),
});

/** A human correction. It wins over every later model proposal. */
export const itemCorrectionValidator = v.object({
	// BetterAuth user id.
	by: v.string(),
	at: v.number(),
	kind: itemCorrectionKindValidator,
});

/** Display text per interface locale. Each value is sealed. */
export const localizedSealedTextValidator = v.object({
	en: v.string(), // sealed
	de: v.string(), // sealed
});

// ── Facts ──────────────────────────────────────────────────────────────────

/** A fact's structured value. The string payloads of `ref` / `url` / `text` are sealed. */
export const factValueValidator = v.union(
	v.object({ kind: v.literal('date'), at: v.number(), tz: v.optional(v.string()) }),
	v.object({ kind: v.literal('money'), value: v.number(), currency: v.string() }),
	v.object({ kind: v.literal('ref'), text: v.string() }), // sealed
	v.object({ kind: v.literal('url'), text: v.string() }), // sealed
	v.object({ kind: v.literal('text'), text: v.string() }) // sealed
);

// ── Activity ───────────────────────────────────────────────────────────────

/** Who did it. `id` = BetterAuth user id for `user`, the agent action id for `agent`. */
export const activityActorValidator = v.object({
	kind: activityActorKindValidator,
	id: v.optional(v.string()),
});

/** The record an activity row links to (sent message, booking, audit row, agent action, note). */
export const activityOpRefValidator = v.object({
	kind: activityOpRefKindValidator,
	id: v.string(),
});

/** What an item activity changed. */
export const activityDeltaValidator = v.object({
	statusFrom: v.optional(itemStatusValidator),
	statusTo: v.optional(itemStatusValidator),
	dispositionFrom: v.optional(itemDispositionValidator),
	dispositionTo: v.optional(itemDispositionValidator),
	completion: v.optional(itemCompletionValidator),
	factId: v.optional(v.id('threadFacts')),
	replacedById: v.optional(v.id('threadItems')),
});

// ── Response plans ─────────────────────────────────────────────────────────

/** Which draft a plan belongs to: a Postbox draft or a team inbound message's draft. */
export const draftRefValidator = v.union(
	v.object({ kind: v.literal('mailDraft'), id: v.id('mailDrafts') }),
	v.object({ kind: v.literal('inboundDraft'), id: v.id('inboundMessages') })
);
export type DraftRef = Infer<typeof draftRefValidator>;

/** The indexed columns of a draft reference (`draftResponsePlans`), the threadRef pattern. */
export type DraftRefColumns =
	| { draftKind: 'mailDraft'; mailDraftId: Id<'mailDrafts'>; inboundMessageId?: undefined }
	| { draftKind: 'inboundDraft'; inboundMessageId: Id<'inboundMessages'>; mailDraftId?: undefined };

export function draftRefToFields(ref: DraftRef): DraftRefColumns {
	return ref.kind === 'mailDraft'
		? { draftKind: 'mailDraft', mailDraftId: ref.id }
		: { draftKind: 'inboundDraft', inboundMessageId: ref.id };
}

/** Rebuild a draft reference from its columns; throws on a row that breaks the xor invariant. */
export function draftRefFromFields(row: {
	draftKind: DraftRef['kind'];
	mailDraftId?: Id<'mailDrafts'>;
	inboundMessageId?: Id<'inboundMessages'>;
}): DraftRef {
	if (row.draftKind === 'mailDraft' && row.mailDraftId && !row.inboundMessageId) {
		return { kind: 'mailDraft', id: row.mailDraftId };
	}
	if (row.draftKind === 'inboundDraft' && row.inboundMessageId && !row.mailDraftId) {
		return { kind: 'inboundDraft', id: row.inboundMessageId };
	}
	throw new Error(`draft ref columns do not match draftKind '${row.draftKind}'`);
}

/** One item's stance in a plan, and who chose it. */
export const responsePlanStanceValidator = v.object({
	itemId: v.id('threadItems'),
	stance: responseStanceValidator,
	source: v.union(v.literal('default'), v.literal('owner'), v.literal('policy')),
});

/** The item revision a plan was built against; a newer revision makes it stale. */
export const itemRevisionRefValidator = v.object({
	itemId: v.id('threadItems'),
	revision: v.number(),
});

/** A clarification answer the draft used. The answer itself lives on the question. */
export const ownerInputRefValidator = v.object({
	questionId: v.string(),
	itemId: v.optional(v.id('threadItems')),
});

/** A span of the draft text (offsets into the draft body). */
export const draftSpanValidator = v.object({ start: v.number(), end: v.number() });

/** Per-item coverage of a draft. Shown as "Addressed in draft", never "Done". */
export const coverageEntryValidator = v.object({
	itemId: v.id('threadItems'),
	spans: v.array(draftSpanValidator),
	verdict: coverageVerdictValidator,
});

/** A promise the draft makes that no item asked for. */
export const newPromiseValidator = v.object({
	text: v.string(), // sealed
	spans: v.array(draftSpanValidator),
	due: v.optional(itemDueValidator),
});

/** "I've attached …" in the draft, checked against the real attachments. */
export const fileClaimValidator = v.object({
	text: v.string(), // sealed
	spans: v.array(draftSpanValidator),
	isMatched: v.boolean(),
	// The attachment that satisfies the claim, when one does.
	attachmentId: v.optional(v.string()),
});

// ── Viewer state ───────────────────────────────────────────────────────────

/** The last team-stream entry a viewer actually saw (stream order is `at`, then `key`). */
export const streamPositionValidator = v.object({
	at: v.number(),
	key: v.string(),
});

/** Eligibility inputs persisted so a retry sees the same ones (SPEC §4 eligibility). */
export const interpretEligibilitySignalsValidator = v.object({
	isLive: v.boolean(),
	folder: v.optional(v.string()),
	isThreadMuted: v.boolean(),
	// A List-Unsubscribe or Precedence bulk/list header is present.
	isBulkHeaderPresent: v.boolean(),
	// The owner (or the inbox) has written to the sender before.
	isSenderKnown: v.boolean(),
	category: v.optional(v.string()),
});
