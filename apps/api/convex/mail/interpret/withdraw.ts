/**
 * Withdrawing what one message's read contributed to its thread brief, without
 * erasing anything a person set (#1320): a re-verified signature verdict
 * narrowed what of the message is read (a clearsigned scope: the signed block
 * only), so claims taken from the rest of it no longer stand. Runs in the
 * transaction that applies the narrower scope, whether or not a new read can
 * run (the `ai` flag, the spend hold), so nothing of the old read reaches a
 * machine consumer in between.
 *
 *  - The source's extractions are marked `isWithdrawn`: the next read knows
 *    there is something to restore ({@link restoreWithdrawn}).
 *  - An item only this message supported is held as a proposal ("Check this":
 *    out of draft plans, the to-do list, team actions and every gate that
 *    reads `verify`), flagged for review and kept out of the model's input
 *    (`load.ts`). Its identity, quotes and every human field (status,
 *    completion, confirmation, reminder, undo snapshot) stay; `withdrawnFrom`
 *    keeps its previous `verify`.
 *  - An item another message supports too loses only this message's quotes,
 *    and is flagged for review when this message set one of its shown fields.
 *  - A status or disposition this message's transition set is reset, a held
 *    update loses what it proposed (as a purge would); what a person set stays.
 *  - A fact only this message supported is `retracted` (out of the brief and
 *    the model's input); one other messages support loses only its quotes.
 *  - The brief: a new revision (the overview cache goes), no checkpoint (the
 *    "latest" lines) naming this message, the list projection refreshed, and
 *    the thread's reply plans go stale.
 *
 * Other messages' contributions are not touched. A later read of the message
 * that reproduces a withdrawn row restores it by identity (the claim record
 * matches it back), in the reducer's transaction ({@link restoreWithdrawn}).
 * Bounded: one thread's rows, at most {@link THREAD_ROW_CAP} per table.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import { writeItemChange } from './counters';
import { isHolding, withoutSources } from './heldSources';
import { transitionReset } from './purgeClaims';

/** Rows of one thread a withdrawal or a restore reads, per table. */
export const THREAD_ROW_CAP = 500;

type Held = NonNullable<Doc<'threadItems'>['pendingUpdate']>;

function fromSource(sourceKey: string) {
	return (e: { source: InterpretationSource }) => interpretationSourceKey(e.source) === sourceKey;
}

function threadRows<T extends 'threadItems' | 'threadFacts'>(
	ctx: MutationCtx,
	table: T,
	threadId: Id<'mailThreads'>
) {
	return ctx.db
		.query(table)
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.take(THREAD_ROW_CAP);
}

/** Withdraw what `source`'s read contributed to its mail thread (see the module doc). */
export async function withdrawSourceRead(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	source: InterpretationSource
): Promise<void> {
	const ref: ThreadRef = { kind: 'mail', id: threadId };
	const key = interpretationSourceKey(source);
	const now = Date.now();
	const reads = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_revision', (q) => q.eq('sourceKey', key))
		.take(THREAD_ROW_CAP);
	for (const row of reads) if (!row.isWithdrawn) await ctx.db.patch(row._id, { isWithdrawn: true });
	for (const item of await threadRows(ctx, 'threadItems', threadId)) {
		await withdrawItem(ctx, ref, item, source, now);
	}
	for (const fact of await threadRows(ctx, 'threadFacts', threadId)) {
		if (fact.status !== 'current' || !fact.evidence.some(fromSource(key))) continue;
		const others = fact.evidence.filter((e) => !fromSource(key)(e));
		await ctx.db.patch(
			fact._id,
			others.length === 0
				? { status: 'retracted', withdrawnFrom: { sourceKey: key, at: now }, updatedAt: now }
				: { evidence: others, updatedAt: now }
		);
	}
	const brief = await loadBriefRow(ctx, ref);
	if (brief) {
		const isCheckpointGone = brief.checkpoint?.sourceKey === key;
		await ctx.db.patch(brief._id, {
			interpretationRevision: brief.interpretationRevision + 1,
			overview: undefined,
			...(isCheckpointGone ? { checkpoint: undefined } : {}),
			updatedAt: now,
		});
		await refreshBriefTop(ctx, threadId, isCheckpointGone ? { latest: null } : {});
	}
	const plans = await ctx.db
		.query('draftResponsePlans')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.take(THREAD_ROW_CAP);
	for (const plan of plans) {
		await ctx.db.patch(plan._id, {
			verdict: 'stale',
			planRevision: (plan.planRevision ?? 0) + 1,
			updatedAt: now,
		});
	}
}

async function withdrawItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	source: InterpretationSource,
	now: number
): Promise<void> {
	const key = interpretationSourceKey(source);
	const isOwn = fromSource(key);
	const held = item.pendingUpdate;
	const isHeldNamed =
		!!held &&
		(held.evidence.some(isOwn) ||
			(held.fieldSources ?? []).some((f) => f.sourceKey === key) ||
			(held.transitions ?? []).some((t) => t.sourceKey === key));
	const isNamed = item.evidence.some(isOwn);
	const reset = transitionReset(item, { ids: new Set([source.id]), keys: new Set([key]) });
	if (!isNamed && !isHeldNamed && !reset) return;
	const others = item.evidence.filter((e) => !isOwn(e));
	const patch: Parameters<typeof writeItemChange>[3] = {
		...reset,
		revision: item.revision + 1,
		updatedAt: now,
	};
	if (isHeldNamed) patch.pendingUpdate = heldWithout(held!, key);
	if (isNamed && others.length === 0) {
		// Nothing else supports it: a proposal for review; its quotes stay, the record of the read.
		patch.verify = 'proposal';
		if (!item.withdrawnFrom) patch.withdrawnFrom = { sourceKey: key, at: now, verify: item.verify };
	} else if (isNamed) {
		patch.evidence = others;
		const sources = Object.values(item.fieldSources ?? {});
		if (sources.some((s) => s?.sourceKey === key)) patch.isReviewNeeded = true;
	}
	await writeItemChange(ctx, ref, item, patch);
}

/** A held update without what `key` proposed; gone when nothing is left. Pure. */
function heldWithout(held: Held, key: string): Held | undefined {
	const kept = withoutSources(held, new Set([key]));
	const evidence = held.evidence.filter((e) => !fromSource(key)(e));
	const isStanding = held.fieldSources ? isHolding(kept) : (kept.transitions?.length ?? 0) > 0;
	return evidence.length > 0 || isStanding ? { ...kept, evidence } : undefined;
}

/**
 * After a read of `sourceKey` at `contentRevision` was folded in: every row
 * withdrawn from that source which the read supports again (it holds a quote
 * of it) is restored. A fact is current again; an item leaves its proposal
 * state with the `verify` the read gave it, or, when a person had confirmed
 * it, with the one it had before. What the read did not reproduce stays
 * withdrawn.
 */
export async function restoreWithdrawn(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	sourceKey: string,
	contentRevision: string
): Promise<void> {
	const ref: ThreadRef = { kind: 'mail', id: threadId };
	const isReread = (e: { source: InterpretationSource; contentRevision: string }) =>
		fromSource(sourceKey)(e) && e.contentRevision === contentRevision;
	const now = Date.now();
	for (const item of await threadRows(ctx, 'threadItems', threadId)) {
		const withdrawn = item.withdrawnFrom;
		if (withdrawn?.sourceKey !== sourceKey || !item.evidence.some(isReread)) continue;
		await writeItemChange(ctx, ref, item, {
			withdrawnFrom: undefined,
			verify: item.correction?.kind === 'confirmed' ? withdrawn.verify : item.verify,
			revision: item.revision + 1,
			updatedAt: now,
		});
	}
	for (const fact of await threadRows(ctx, 'threadFacts', threadId)) {
		if (fact.withdrawnFrom?.sourceKey !== sourceKey || !fact.evidence.some(isReread)) continue;
		await ctx.db.patch(fact._id, { status: 'current', withdrawnFrom: undefined, updatedAt: now });
	}
}
