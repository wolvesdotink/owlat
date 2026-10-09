/**
 * Transitions on an obligation not seen yet (review rounds 5 F7, 6 F1/F3): a
 * completion read before its delayed request (`itemId` absent, `about` set)
 * is kept on its extraction row (`pendingTransitions`, its indexes,
 * `reduceIdentity.pendingFieldsOf`).
 *
 * A wording match is never identity (round 6 R1): it NEVER changes a status
 * or disposition by itself. When a later fold creates items, every pending
 * row of the thread is scanned, and a pending transition whose `about` reads
 * like one of the new items becomes a visible proposal on that item: a held
 * transition in its `pendingUpdate` ("A later message may have settled this
 * — confirm?"), with the quotes behind it, and `isReviewNeeded`. The pending
 * transition stays pending until a person confirms the proposal
 * (`reactions.ts confirmProposal`, which settles it here) or a re-read of its
 * message names the item exactly (that read replaces the row and its
 * pending set).
 *
 * Nothing is capped away (round 6 R2): the scan pages through ALL pending
 * rows of the thread by creation time, one page per run, continuing itself
 * with a durable cursor (its scheduled arguments) and the candidate item ids;
 * the brief counts the runs in flight (`pendingMatchRuns`) and stays partial
 * until the last one finishes. A purge (a new `deletionEpoch`) ends the scan.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import type { Evidence } from '../../lib/validators/threadBrief';
import {
	rowMatchesThreadRef,
	threadRefValidator,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { appendActivity } from './activity';
import { EMPTY_SOURCE_COUNTS, completenessOfCounts, writeItemChange } from './counters';
import { evidenceKey } from './evidence';
import { readResult } from './load';
import { textSimilarity } from './reducePlan';
import { pendingFieldsOf } from './reduceIdentity';
import type { ReduceTransition } from './reduceInput';

/** Pending rows one run reads. */
const PAGE = 20;
/** How close a pending transition's `about` must read to a new item's assertion. */
const MATCH_MIN = 0.5;

type HeldTransition = NonNullable<
	NonNullable<Doc<'threadItems'>['pendingUpdate']>['transitions']
>[number];

function pendingPage(ctx: MutationCtx, ref: ThreadRef, after: number | undefined, n: number) {
	return ref.kind === 'mail'
		? ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread_pending', (q) =>
					after === undefined
						? q.eq('mailThreadId', ref.id).eq('isPendingTransitions', true)
						: q
								.eq('mailThreadId', ref.id)
								.eq('isPendingTransitions', true)
								.gt('_creationTime', after)
				)
				.take(n)
		: ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread_pending', (q) =>
					after === undefined
						? q.eq('conversationThreadId', ref.id).eq('isPendingTransitions', true)
						: q
								.eq('conversationThreadId', ref.id)
								.eq('isPendingTransitions', true)
								.gt('_creationTime', after)
				)
				.take(n);
}

/**
 * The reducer's hook after it inserted `itemIds`: when the thread holds
 * pending transitions, count a scan run on the brief (it goes partial until
 * the run ends) and return the first run's arguments, which `reduce.ts`
 * schedules (`matchPendingTransitions`). Null: nothing to scan.
 */
export async function startPendingMatch(
	ctx: MutationCtx,
	ref: ThreadRef,
	brief: Pick<Doc<'threadBriefs'>, '_id' | 'deletionEpoch'>,
	itemIds: readonly Id<'threadItems'>[],
	/** The source that created the items: its own pending transitions are not about them. */
	sourceKey: string
): Promise<PendingMatchArgs | null> {
	if (itemIds.length === 0) return null;
	if ((await pendingPage(ctx, ref, undefined, 1)).length === 0) return null;
	const fresh = await ctx.db.get(brief._id);
	if (!fresh) return null;
	await ctx.db.patch(brief._id, {
		pendingMatchRuns: (fresh.pendingMatchRuns ?? 0) + 1,
		completeness: 'partial',
		updatedAt: Date.now(),
	});
	return { threadRef: ref, itemIds: [...itemIds], sourceKey, deletionEpoch: brief.deletionEpoch };
}

/** One scan run ends: the brief's completeness comes from its counts again when none is left. */
async function finishRun(ctx: MutationCtx, brief: Doc<'threadBriefs'>): Promise<void> {
	const runs = Math.max(0, (brief.pendingMatchRuns ?? 1) - 1);
	await ctx.db.patch(brief._id, {
		pendingMatchRuns: runs > 0 ? runs : undefined,
		...(runs === 0
			? {
					completeness: brief.isFoldScanCut
						? ('partial' as const)
						: completenessOfCounts(brief.sourceCounts ?? EMPTY_SOURCE_COUNTS),
				}
			: {}),
		updatedAt: Date.now(),
	});
}

/** Can a pending transition be proposed at all (the planner's own refusals)? Pure. */
function isProposable(t: ReduceTransition): boolean {
	if (!t.about || (!t.to && !t.disposition)) return false;
	if (t.to === 'untracked' || t.disposition === 'failed') return false;
	const isClosing = t.to === 'done' || t.to === 'declined' || t.to === 'superseded';
	return !isClosing || t.isVerified;
}

async function sealedEvidence(
	t: ReduceTransition,
	row: Doc<'messageInterpretations'>
): Promise<Evidence[]> {
	return Promise.all(
		t.evidence.map(async (e) => ({
			source: row.source,
			contentRevision: row.contentRevision,
			segmentId: e.segmentId,
			start: e.start,
			end: e.end,
			quote: await sealBodyAtWrite(e.quote),
			...(e.occurrence !== undefined ? { occurrence: e.occurrence } : {}),
			...(e.occurrenceCount !== undefined ? { occurrenceCount: e.occurrenceCount } : {}),
		}))
	);
}

/** Hold one pending transition on its candidate item, for a person to confirm. */
async function holdOnItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	row: Doc<'messageInterpretations'>,
	index: number,
	t: ReduceTransition
): Promise<void> {
	const held = item.pendingUpdate;
	const isHeld = (held?.transitions ?? []).some(
		(h) => h.interpretationId === row._id && h.index === index
	);
	if (isHeld) return;
	const transition: HeldTransition = {
		...(t.to ? { to: t.to } : {}),
		...(t.disposition ? { disposition: t.disposition } : {}),
		sourceKey: row.sourceKey,
		at: row.sourceAt ?? row.createdAt,
		interpretationId: row._id,
		index,
	};
	const seen = new Set([...item.evidence, ...(held?.evidence ?? [])].map(evidenceKey));
	const added = (await sealedEvidence(t, row)).filter((e) => !seen.has(evidenceKey(e)));
	const revision = item.revision + 1;
	await appendActivity(ctx, {
		threadRef: ref,
		idempotencyKey: `pendingMatch:${row._id}:${index}:${item._id}`,
		type: 'item_changed',
		actor: { kind: 'system' },
		provenance: 'reported',
		itemId: item._id,
		itemRevision: revision,
	});
	await writeItemChange(ctx, ref, item, {
		pendingUpdate: {
			...held,
			evidence: [...(held?.evidence ?? []), ...added],
			transitions: [...(held?.transitions ?? []), transition],
		},
		isReviewNeeded: true,
		revision,
		updatedAt: Date.now(),
	});
}

const pendingMatchArgs = v.object({
	threadRef: threadRefValidator,
	itemIds: v.array(v.id('threadItems')),
	sourceKey: v.string(),
	deletionEpoch: v.number(),
	/** The durable cursor: the creation time of the last pending row read. */
	after: v.optional(v.number()),
});
type PendingMatchArgs = Infer<typeof pendingMatchArgs>;

/** One page of the scan: propose the page's pending transitions to the candidates. */
export const matchPendingTransitions = internalMutation({
	args: pendingMatchArgs.fields,
	handler: async (ctx, args): Promise<void> => {
		const ref = args.threadRef;
		const brief = await loadBriefRow(ctx, ref);
		if (!brief) return;
		if (brief.deletionEpoch !== args.deletionEpoch) {
			await finishRun(ctx, brief);
			return;
		}
		const candidates: Array<{ id: Id<'threadItems'>; text: string }> = [];
		for (const id of args.itemIds) {
			const item = await ctx.db.get(id);
			if (!item || !rowMatchesThreadRef(item, ref) || item.status !== 'open') continue;
			candidates.push({ id, text: await openMessageBody(item.assertion) });
		}
		const rows = await pendingPage(ctx, ref, args.after, PAGE);
		for (const row of candidates.length > 0 ? rows : []) {
			if (row.isCurrent === false || row.sourceKey === args.sourceKey) continue;
			const result = await readResult(row);
			if (!result) continue;
			for (const index of row.pendingTransitions ?? []) {
				const t = result.transitions[index];
				if (!t || !isProposable(t)) continue;
				let best: { id: Id<'threadItems'>; score: number } | null = null;
				for (const candidate of candidates) {
					const score = textSimilarity(t.about!, candidate.text);
					if (score >= MATCH_MIN && (!best || score > best.score))
						best = { id: candidate.id, score };
				}
				const item = best ? await ctx.db.get(best.id) : null;
				if (item) await holdOnItem(ctx, ref, item, row, index, t);
			}
		}
		const last = rows[rows.length - 1];
		if (rows.length === PAGE && last && candidates.length > 0) {
			await ctx.scheduler.runAfter(
				0,
				internal.mail.interpret.pendingMatch.matchPendingTransitions,
				{
					...args,
					after: last._creationTime,
				}
			);
			return;
		}
		await finishRun(ctx, brief);
	},
});

/**
 * The held transitions that still stand: their row is current and still has
 * the transition pending (a re-read may have replaced it since).
 */
export async function liveHeldTransitions(
	ctx: MutationCtx,
	transitions: readonly HeldTransition[]
): Promise<HeldTransition[]> {
	const live: HeldTransition[] = [];
	for (const t of transitions) {
		const row = await ctx.db.get(t.interpretationId);
		if (row?.isCurrent !== false && row?.pendingTransitions?.includes(t.index)) live.push(t);
	}
	return live;
}

/** A person confirmed these held transitions: they are no longer pending on their rows. */
export async function settleHeldTransitions(
	ctx: MutationCtx,
	transitions: readonly HeldTransition[]
): Promise<void> {
	const byRow = new Map<Id<'messageInterpretations'>, Set<number>>();
	for (const t of transitions) {
		byRow.set(t.interpretationId, (byRow.get(t.interpretationId) ?? new Set()).add(t.index));
	}
	for (const [rowId, settled] of byRow) {
		const row = await ctx.db.get(rowId);
		if (!row?.pendingTransitions) continue;
		await ctx.db.patch(
			rowId,
			pendingFieldsOf(row.pendingTransitions.filter((index) => !settled.has(index)))
		);
	}
}

/** Undo of a confirmation: its transitions are pending again on rows that still stand (round 7 F2). */
export async function restoreHeldTransitions(
	ctx: MutationCtx,
	transitions: readonly HeldTransition[]
): Promise<void> {
	for (const t of transitions) {
		const row = await ctx.db.get(t.interpretationId);
		if (!row || row.isCurrent === false || row.pendingTransitions?.includes(t.index)) continue;
		await ctx.db.patch(row._id, pendingFieldsOf([...(row.pendingTransitions ?? []), t.index]));
	}
}

/** The sources of the messages the held transitions came from (one each). */
export async function heldTransitionSources(
	ctx: MutationCtx,
	transitions: readonly HeldTransition[]
): Promise<Doc<'messageInterpretations'>['source'][]> {
	const sources = new Map<string, Doc<'messageInterpretations'>['source']>();
	for (const t of transitions) {
		if (!t.disposition || sources.has(t.sourceKey)) continue;
		const row = await ctx.db.get(t.interpretationId);
		if (row) sources.set(t.sourceKey, row.source);
	}
	return [...sources.values()];
}
