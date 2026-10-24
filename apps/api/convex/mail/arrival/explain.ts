/**
 * Read on arrival, Explain: "Why here?" answers from the thread's
 * newest inbound arrival record.
 *
 * {@link forThread} returns what placed the thread where it is, recomputed
 * from the same inputs as the projection (`placementOf`), plus the record's
 * reason keys (rendered by the client from `postbox.<key>`), the sender's
 * counters over the window ("about 90 days"), the read depth and the model
 * calls it cost.
 *
 * Mailbox access is checked like every Postbox thread read; a team inbox has
 * no records and reads as null. A FENCED thread (`mail/interpret/staleFence.ts`)
 * shows nothing the model derived: the reason keys are filtered to the
 * deterministic ones, and a category or rule placement that came from a model
 * answer is left out.
 */

import { v } from 'convex/values';
import type {
	Depth,
	MailCategory,
	Placement,
	PlacementDecider,
	ReasonKey,
} from '@owlat/shared/arrival';
import { ARRIVAL_DEPTH_REASONS } from '@owlat/shared/arrivalDepth';
import type { Doc, Id } from '../../_generated/dataModel';
import { postboxQuery } from '../_helpers';
import { isFencedThread } from '../interpret/staleFence';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import { senderWindowTotals } from '../senders/counters';
import { placementOf, senderProfileOf } from './projection';
import { loadColdPitchStanding } from './coldPitchEvidence';
import { newestArrivalRecord } from './records';

type ArrivalRecord = Doc<'mailArrivalRecords'>;
type Profile = Doc<'mailSenderProfiles'>;

/**
 * Reason keys that say nothing a model derived: the ladder's own rungs
 * (setting, eligibility, budget, admission, overrides, the exact-wording
 * screen). A category reason is deterministic only when the category was not
 * the model's. Anything else (a key a later lane adds) is hidden on a fenced
 * thread: unknown is treated as model-derived.
 */
const DETERMINISTIC_REASON_KEYS: ReadonlySet<string> = new Set([
	ARRIVAL_DEPTH_REASONS.aiOff,
	ARRIVAL_DEPTH_REASONS.ineligible,
	ARRIVAL_DEPTH_REASONS.openWork,
	ARRIVAL_DEPTH_REASONS.readOnArrivalOff,
	ARRIVAL_DEPTH_REASONS.senderStatus,
	ARRIVAL_DEPTH_REASONS.security,
	ARRIVAL_DEPTH_REASONS.budget,
	ARRIVAL_DEPTH_REASONS.override,
	ARRIVAL_DEPTH_REASONS.exactWording,
	'arrival.reason.ownerLimit',
	'arrival.reason.categoryTimeout',
	'arrival.reason.gistUnavailable',
	'arrival.reason.gistFailed',
]);

/** Whether a rule placement on the record came from an AI-conditioned filter's yes. */
function isRulePlacementFromModel(record: Pick<ArrivalRecord, 'filterMatches'>): boolean {
	return (record.filterMatches ?? []).some((m) => m.pass === 'ai' && m.answer === true);
}

/** Whether one reason key may be shown on a fenced thread. Pure. */
export function isReasonShownWhenFenced(
	reason: ReasonKey,
	record: Pick<ArrivalRecord, 'filterMatches'>
): boolean {
	if (reason.key === ARRIVAL_DEPTH_REASONS.category) return reason.params?.['source'] !== 'llm';
	if (reason.key === ARRIVAL_DEPTH_REASONS.digest) {
		return reason.params?.['by'] !== 'rule' || !isRulePlacementFromModel(record);
	}
	return DETERMINISTIC_REASON_KEYS.has(reason.key);
}

/** What "Why here?" shows for one thread. */
export interface ArrivalExplanation {
	threadId: Id<'mailThreads'>;
	/** The newest inbound message the record belongs to (what Fix acts on). */
	messageId: Id<'mailMessages'>;
	placement: Placement;
	decidedBy: PlacementDecider;
	/** A placement a person set, and where they set it. */
	override?: { scope: 'thread' | 'sender'; placement: Placement };
	sender: {
		address: string;
		displayName?: string;
		senderDigest?: string;
		status?: Profile['status'];
		statusSource?: Profile['statusSource'];
		/** Over the window ("about 90 days"); absent without a profile. */
		delivered?: number;
		opened?: number;
	};
	category?: { label: MailCategory; source: 'heuristic' | 'llm' | 'user' };
	rulePlacement?: Placement;
	isReplyNeeded: boolean;
	depth?: Depth;
	modelCalls: number;
	degradedBy?: ArrivalRecord['degradedBy'];
	reasons: ReasonKey[];
	isFenced: boolean;
}

function overrideOf(
	thread: Doc<'mailThreads'>,
	profile: Profile | null,
	decidedBy: PlacementDecider
): ArrivalExplanation['override'] {
	if (decidedBy === 'thread_override' && thread.placementOverride) {
		return { scope: 'thread', placement: thread.placementOverride.placement };
	}
	if (decidedBy === 'sender_override' && profile?.placementOverride) {
		return { scope: 'sender', placement: profile.placementOverride };
	}
	return undefined;
}

function senderOf(
	message: Doc<'mailMessages'>,
	profile: Profile | null,
	now: number
): ArrivalExplanation['sender'] {
	const name = message.fromName?.trim() || profile?.displayName;
	const base = {
		address: profile?.address ?? message.fromAddress,
		...(name ? { displayName: name } : {}),
	};
	if (!profile) return base;
	const totals = senderWindowTotals(profile, now);
	return {
		...base,
		senderDigest: profile.senderDigest,
		status: profile.status,
		statusSource: profile.statusSource,
		delivered: totals.delivered,
		opened: totals.opened,
	};
}

/** Why the thread sits where it does (see the module doc); null when there is nothing to explain. */
export const forThread = postboxQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session): Promise<ArrivalExplanation | null> => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const owned = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!owned.ok || !isPersonalMailbox(owned.mailbox)) return null;
		const record = await newestArrivalRecord(ctx, thread._id);
		if (!record) return null;
		const message = await ctx.db.get(record.messageId);
		if (!message) return null;
		const profile = await senderProfileOf(ctx, thread.mailboxId, message.fromAddress);
		const isColdPitch = await loadColdPitchStanding(ctx, record);
		const { placement, decidedBy } = placementOf(record, thread, profile, isColdPitch);
		const isFenced = isFencedThread(thread);
		const label = record.category ?? thread.category?.label;
		const source = record.categorySource ?? thread.category?.source;
		const isCategoryShown =
			label !== undefined && source !== undefined && !(isFenced && source === 'llm');
		const isRuleShown =
			record.rulePlacement !== undefined && !(isFenced && isRulePlacementFromModel(record));
		const override = overrideOf(thread, profile, decidedBy);
		return {
			threadId: thread._id,
			messageId: message._id,
			placement,
			decidedBy,
			...(override ? { override } : {}),
			sender: senderOf(message, profile, Date.now()),
			...(isCategoryShown ? { category: { label, source } } : {}),
			...(isRuleShown ? { rulePlacement: record.rulePlacement } : {}),
			isReplyNeeded: decidedBy === 'needs_reply',
			...(record.depth ? { depth: record.depth } : {}),
			modelCalls: record.modelCalls,
			...(record.degradedBy ? { degradedBy: record.degradedBy } : {}),
			reasons: isFenced
				? record.reasonKeys.filter((reason) => isReasonShownWhenFenced(reason, record))
				: record.reasonKeys,
			isFenced,
		};
	},
});
