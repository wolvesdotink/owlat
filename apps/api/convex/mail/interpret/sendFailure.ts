/**
 * A send that failed takes back what it answered (SPEC §5 "Outbound"): when a
 * Postbox recipient bounces or fails, or a team reply's Send fails or bounces,
 * the item dispositions THAT send moved (`answered`, `accepted`, `deferred`,
 * `declined`) become `failed`. Nothing else is recomputed: items the send did
 * not touch, and items something later moved again, stay as they are.
 *
 * Which items depended on the send is read from the reducer's own record: an
 * item patch from an outbound source is a `threadActivity` row whose stored key
 * starts with `<threadRefKey>|interp:<sourceKey>:` (`reduce.ts` keyBase,
 * `activity.ts` scopedIdempotencyKey) and whose delta carries `dispositionTo`.
 * A Postbox send to several people only fails the items of the people it did
 * not reach (the item's counterparty), unless it reached nobody.
 *
 * {@link reconcileSendFailure} reads the send's current state, so it is called
 * both when the failure lands and after the send's interpretation is applied
 * (a bounce can arrive before the model has read the sent message). It is
 * idempotent: each (source, item) pair is failed at most once. A resend that
 * gets through is a new source and is interpreted again normally.
 */

import { v } from 'convex/values';
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
import type { ThreadRef } from '../../lib/validators/threadRef';
import { appendActivity, scopedIdempotencyKey } from './activity';
import { refreshBriefTop } from './briefTop';

/** Reducer rows one send can have produced (items × extractor versions); bounded. */
const DEPENDENT_SCAN = 200;

/** Delivery states that mean "this recipient never got it". */
const FAILED_RECIPIENT_STATES: ReadonlySet<string> = new Set(['bounced', 'failed']);
const FAILED_SEND_STATUSES: ReadonlySet<string> = new Set(['bounced', 'failed']);

export type OutboundSource = Extract<InterpretationSource, { kind: 'outboundMail' | 'teamReply' }>;

/** Who a send did not reach: every recipient, or the listed (normalized) addresses. */
export type SendFailureScope = { isEveryone: true } | { isEveryone: false; addresses: string[] };

/**
 * The items whose disposition this source moved, with the value it set. The
 * newest row per item wins (a re-extraction of the same source).
 */
export async function dependentDispositions(
	ctx: Pick<MutationCtx, 'db'>,
	ref: ThreadRef,
	source: OutboundSource
): Promise<Map<Id<'threadItems'>, Doc<'threadItems'>['disposition']>> {
	const prefix = scopedIdempotencyKey(ref, `interp:${interpretationSourceKey(source)}:`);
	const rows = await ctx.db
		.query('threadActivity')
		.withIndex('by_idempotency_key', (q) =>
			q.gte('idempotencyKey', prefix).lt('idempotencyKey', `${prefix}￿`)
		)
		.take(DEPENDENT_SCAN);
	const moved = new Map<Id<'threadItems'>, Doc<'threadItems'>['disposition']>();
	for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
		const to = row.delta?.dispositionTo;
		if (row.itemId && to && to !== 'failed') moved.set(row.itemId, to);
	}
	return moved;
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
		if (!item || item.disposition !== setTo) continue;
		if (missed && !(item.counterpartyKey && missed.has(item.counterpartyKey))) continue;
		if (!isLegalDispositionEdge(item.disposition, 'failed')) continue;
		const revision = item.revision + 1;
		const appended = await appendActivity(ctx, {
			threadRef: args.threadRef,
			idempotencyKey: `send_failed:${sourceKey}:item:${itemId}`,
			type: 'item_changed',
			actor: { kind: 'system' },
			provenance: 'recorded',
			itemId,
			itemRevision: revision,
			delta: { dispositionFrom: item.disposition, dispositionTo: 'failed' },
			opRef: { kind: 'outbound', id: args.source.id },
		});
		// Failed once by this send already (then answered again by another): leave it.
		if (!appended || appended.isDuplicate) continue;
		await ctx.db.patch(itemId, { disposition: 'failed', revision, updatedAt: now });
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
	if (!send || !FAILED_SEND_STATUSES.has(send.status) || !send.inboundMessageId) return null;
	const inbound = await ctx.db.get(send.inboundMessageId);
	if (!inbound?.threadId) return null;
	return { threadRef: { kind: 'team', id: inbound.threadId }, scope: { isEveryone: true } };
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
