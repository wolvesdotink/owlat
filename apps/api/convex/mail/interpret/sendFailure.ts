/**
 * A send that failed takes back what it answered (SPEC §5 "Outbound"): when a
 * Postbox recipient bounces or fails, or a team reply's Send fails or bounces,
 * the item dispositions THAT send moved (`answered`, `accepted`, `deferred`,
 * `declined`) become `failed`. Nothing else is recomputed: items the send did
 * not touch, and items something later moved again, stay as they are.
 *
 * Which items depend on the send is read from the items themselves (review
 * round 7 F5): `threadItems.dispositionSource.sourceKey` names the source
 * that set (or last reaffirmed) the standing disposition, whether the reducer
 * set it or a person confirmed a held transition (`pendingMatch.ts`); the
 * `by_disposition_source` index finds them.
 * A Postbox send to several people only fails the items of the people it did
 * not reach (the item's counterparty), unless it reached nobody.
 *
 * {@link reconcileSendFailure} reads the send's current state, so it is called
 * both when the failure lands and after the send's interpretation is applied
 * (a bounce can arrive before the model has read the sent message). It is
 * idempotent: once failed, the item's disposition no longer rests on the send. A resend that
 * gets through is a new source and is interpreted again normally.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { normalizeEmail } from '@owlat/shared';
import { isLegalDispositionEdge } from '@owlat/shared/threadBriefRules';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { rowMatchesThreadRef, type ThreadRef } from '../../lib/validators/threadRef';
import { appendActivity } from './activity';
import { refreshBriefTop } from './briefTop';
import { writeItemChange } from './counters';

/** Delivery states that mean "this recipient never got it". */
const FAILED_RECIPIENT_STATES: ReadonlySet<string> = new Set(['bounced', 'failed']);
const FAILED_SEND_STATUSES: ReadonlySet<string> = new Set(['bounced', 'failed']);

export type OutboundSource = Extract<InterpretationSource, { kind: 'outboundMail' | 'teamReply' }>;

/** Who a send did not reach: every recipient, or the listed (normalized) addresses. */
export type SendFailureScope = { isEveryone: true } | { isEveryone: false; addresses: string[] };

/**
 * The items of the thread whose standing disposition rests on this source,
 * with that value. Every one (no cap: a send's items are the ones it answered).
 */
export async function dependentDispositions(
	ctx: Pick<MutationCtx, 'db'>,
	ref: ThreadRef,
	source: OutboundSource
): Promise<Map<Id<'threadItems'>, Doc<'threadItems'>['disposition']>> {
	const rows = await ctx.db
		.query('threadItems')
		.withIndex('by_disposition_source', (q) =>
			q.eq('dispositionSource.sourceKey', interpretationSourceKey(source))
		)
		.collect();
	const moved = new Map<Id<'threadItems'>, Doc<'threadItems'>['disposition']>();
	for (const row of rows) {
		if (rowMatchesThreadRef(row, ref) && row.disposition !== 'failed') {
			moved.set(row._id, row.disposition);
		}
	}
	return moved;
}

/**
 * Whether the item's current disposition still rests on `source`: the value
 * this send set, and no later source supporting it. Equality alone is not
 * dependence: when A answers and B answers again, A bouncing must leave the
 * B-supported `answered` alone. `threadItems.dispositionSource` says which
 * source set the standing value.
 */
function isDispositionStillFrom(
	item: Doc<'threadItems'>,
	source: OutboundSource,
	setTo: Doc<'threadItems'>['disposition']
): boolean {
	if (item.disposition !== setTo) return false;
	// The reducer records which source set the standing disposition (also when
	// a later reply restates it): only this send's own answer is taken back.
	return item.dispositionSource?.sourceKey === interpretationSourceKey(source);
}

/**
 * Set every disposition `source` moved to `failed`, for the items of the
 * people it did not reach (see the module doc). Returns the items changed.
 */
export async function failDependentDispositions(
	ctx: MutationCtx,
	args: { threadRef: ThreadRef; source: OutboundSource; scope: SendFailureScope }
): Promise<Id<'threadItems'>[]> {
	const moved = await dependentDispositions(ctx, args.threadRef, args.source);
	if (moved.size === 0) return [];
	const missed = args.scope.isEveryone ? null : new Set(args.scope.addresses);
	const sourceKey = interpretationSourceKey(args.source);
	const now = Date.now();
	const changed: Id<'threadItems'>[] = [];
	for (const [itemId, setTo] of moved) {
		const item = await ctx.db.get(itemId);
		// Moved again since (a later message, a person): no longer this send's.
		if (!item || !isDispositionStillFrom(item, args.source, setTo)) continue;
		if (missed && !(item.counterpartyKey && missed.has(item.counterpartyKey))) continue;
		if (!isLegalDispositionEdge(item.disposition, 'failed')) continue;
		const revision = item.revision + 1;
		const appended = await appendActivity(ctx, {
			threadRef: args.threadRef,
			// Keyed by the item's revision: the row is deduplicated, never the
			// state (a send supporting the item again fails it again, round 8 F3).
			idempotencyKey: `send_failed:${sourceKey}:item:${itemId}:${item.revision}`,
			type: 'item_changed',
			actor: { kind: 'system' },
			provenance: 'recorded',
			itemId,
			itemRevision: revision,
			delta: { dispositionFrom: item.disposition, dispositionTo: 'failed' },
			opRef: { kind: 'outbound', id: args.source.id },
		});
		if (!appended) continue;
		await writeItemChange(ctx, args.threadRef, item, {
			disposition: 'failed',
			// A recorded operation: the failed send itself is the source now.
			dispositionSource: { sourceKey: `op:${sourceKey}`, at: now },
			revision,
			updatedAt: now,
		});
		changed.push(itemId);
	}
	if (changed.length > 0 && args.threadRef.kind === 'mail') {
		await refreshBriefTop(ctx, args.threadRef.id);
	}
	return changed;
}

/**
 * The thread and the failure scope of a send as it stands now, or null when
 * the send is gone, has no thread, or reached everyone it was meant for.
 */
export async function sendFailureOf(
	ctx: Pick<MutationCtx, 'db'>,
	source: OutboundSource
): Promise<{ threadRef: ThreadRef; scope: SendFailureScope } | null> {
	if (source.kind === 'outboundMail') {
		const message = await ctx.db.get(source.id);
		const recipients = message?.outbound?.recipients ?? [];
		if (!message || recipients.length === 0) return null;
		const failed = recipients.filter((r) => FAILED_RECIPIENT_STATES.has(r.state));
		if (failed.length === 0) return null;
		const threadRef: ThreadRef = { kind: 'mail', id: message.threadId };
		if (failed.length === recipients.length) return { threadRef, scope: { isEveryone: true } };
		return {
			threadRef,
			scope: { isEveryone: false, addresses: failed.map((r) => normalizeEmail(r.address)) },
		};
	}
	const send = await ctx.db.get(source.id);
	if (!send || !FAILED_SEND_STATUSES.has(send.status)) return null;
	const team = await teamThreadOfSend(ctx, send);
	if (!team) return null;
	return { threadRef: team.threadRef, scope: { isEveryone: true } };
}

/**
 * The Team Inbox thread a team reply's Send answers: an agent reply through
 * the inbound message it replies to (`inboundMessageId`), a person's
 * follow-up through its `inboxFollowUps` row (`followUpId`). Null for any
 * other Send, or when the row is gone.
 */
export async function teamThreadOfSend(
	ctx: Pick<MutationCtx, 'db'>,
	send: Pick<Doc<'transactionalSends'>, 'inboundMessageId' | 'followUpId'>
): Promise<{
	threadRef: ThreadRef;
	inbound?: Doc<'inboundMessages'>;
	followUp?: Doc<'inboxFollowUps'>;
} | null> {
	if (send.inboundMessageId) {
		const inbound = await ctx.db.get(send.inboundMessageId);
		return inbound?.threadId
			? { threadRef: { kind: 'team', id: inbound.threadId }, inbound }
			: null;
	}
	if (send.followUpId) {
		const followUp = await ctx.db.get(send.followUpId);
		return followUp ? { threadRef: { kind: 'team', id: followUp.threadId }, followUp } : null;
	}
	return null;
}

/** Fail what `source` answered, if the send (now) failed. Idempotent. */
export async function reconcileSendFailure(
	ctx: MutationCtx,
	source: OutboundSource
): Promise<Id<'threadItems'>[]> {
	const failure = await sendFailureOf(ctx, source);
	if (!failure) return [];
	return failDependentDispositions(ctx, { ...failure, source });
}

/** {@link reconcileSendFailure} for the post-interpretation check (`outboundRun.ts`). */
export const reconcile = internalMutation({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<number> => {
		const source = args.source;
		if (source.kind !== 'outboundMail' && source.kind !== 'teamReply') return 0;
		return (await reconcileSendFailure(ctx, source)).length;
	},
});
