/**
 * Convex validators of a draft's response plan (SPEC §6, `draftResponsePlans`):
 * the draft it belongs to, the stance per item, the coverage of the draft, its
 * file claims and its commitments. Split out of `threadBrief.ts` for the size
 * cap; the literal unions stay there.
 *
 * SEALED strings: a field commented `sealed` holds an at-rest envelope, as in
 * `threadBrief.ts`.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import {
	coverageVerdictValidator,
	itemAmountValidator,
	itemDueValidator,
	responseStanceValidator,
} from './threadBrief';

/**
 * Which draft a plan belongs to: a Postbox draft, a team inbound message's
 * draft, or the reply a Postbox thread's Reply Queue prepared on arrival (no
 * draft row yet; it moves to the Postbox draft the composer creates from it).
 */
export const draftRefValidator = v.union(
	v.object({ kind: v.literal('mailDraft'), id: v.id('mailDrafts') }),
	v.object({ kind: v.literal('inboundDraft'), id: v.id('inboundMessages') }),
	v.object({ kind: v.literal('arrivalDraft'), id: v.id('mailThreads') })
);
export type DraftRef = Infer<typeof draftRefValidator>;

/** The indexed columns of a draft reference (`draftResponsePlans`), the threadRef pattern. */
export type DraftRefColumns =
	| { draftKind: 'mailDraft'; mailDraftId: Id<'mailDrafts'>; inboundMessageId?: undefined }
	| { draftKind: 'inboundDraft'; inboundMessageId: Id<'inboundMessages'>; mailDraftId?: undefined }
	| { draftKind: 'arrivalDraft'; mailDraftId?: undefined; inboundMessageId?: undefined };

export function draftRefToFields(ref: DraftRef): DraftRefColumns {
	if (ref.kind === 'mailDraft') return { draftKind: 'mailDraft', mailDraftId: ref.id };
	if (ref.kind === 'inboundDraft') return { draftKind: 'inboundDraft', inboundMessageId: ref.id };
	return { draftKind: 'arrivalDraft' };
}

/** Rebuild a draft reference from its columns; throws on a row that breaks the xor invariant. */
export function draftRefFromFields(row: {
	draftKind: DraftRef['kind'];
	mailDraftId?: Id<'mailDrafts'>;
	inboundMessageId?: Id<'inboundMessages'>;
	mailThreadId?: Id<'mailThreads'>;
}): DraftRef {
	if (row.draftKind === 'mailDraft' && row.mailDraftId && !row.inboundMessageId) {
		return { kind: 'mailDraft', id: row.mailDraftId };
	}
	if (row.draftKind === 'inboundDraft' && row.inboundMessageId && !row.mailDraftId) {
		return { kind: 'inboundDraft', id: row.inboundMessageId };
	}
	if (
		row.draftKind === 'arrivalDraft' &&
		row.mailThreadId &&
		!row.mailDraftId &&
		!row.inboundMessageId
	) {
		return { kind: 'arrivalDraft', id: row.mailThreadId };
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

/** A span of the draft text (offsets into the normalized draft body). */
export const draftSpanValidator = v.object({ start: v.number(), end: v.number() });

/** Per-item coverage of a draft. Shown as "Addressed in draft", never "Done". */
export const coverageEntryValidator = v.object({
	itemId: v.id('threadItems'),
	spans: v.array(draftSpanValidator),
	verdict: coverageVerdictValidator,
});

/** A commitment the draft makes: to an item, or one nobody asked for. */
export const newPromiseValidator = v.object({
	text: v.string(), // sealed
	spans: v.array(draftSpanValidator),
	due: v.optional(itemDueValidator),
	// The amount the commitment names, when it names one.
	amount: v.optional(itemAmountValidator),
	// The item the promise answers; absent for a promise nobody asked for.
	itemId: v.optional(v.id('threadItems')),
});

/** "I've attached …" in the draft, checked against the real attachments. */
export const fileClaimValidator = v.object({
	text: v.string(), // sealed
	spans: v.array(draftSpanValidator),
	isMatched: v.boolean(),
	// The attachment that satisfies the claim, when one does.
	attachmentId: v.optional(v.string()),
});
