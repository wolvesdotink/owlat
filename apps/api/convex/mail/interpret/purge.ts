/**
 * Thread brief erasure, the message level (SPEC §5 "Erasure"): when a source
 * message is purged (Postbox "Delete forever", the trash auto-purge, an IMAP
 * EXPUNGE, a provider-side deletion pulled in by two-way sync, a contact's
 * erasure taking a Team Inbox message), everything the thread brief derived
 * from it goes or is recomputed, in the purge's transaction:
 *
 *  - its `messageInterpretations` rows (the sealed proposals and latest lines),
 *    taken out of the brief's source counters, and its `interpretSources`
 *    row (eligibility snapshot, a team reply's sent text);
 *  - the activity rows the reducer wrote for it (`received:<source>`,
 *    `interp:<source>:…`), the send pipeline's rows keyed by its id
 *    (`sent:<id>`, `delivery_failed:<id>:…`, `send_queued:<id>:…` …) and any
 *    row whose `opRef` names it;
 *  - its evidence entries on items and facts. "A surviving claim must keep
 *    surviving evidence": an item or fact left without evidence is deleted
 *    (with its links, `purgeRows.ts`, and out of the item counters); one
 *    replaced or superseded by a deleted claim comes back (`open` /
 *    `current`, through `counters.ts writeItemChange`); pointers to deleted claims are
 *    cleared on the survivors;
 *  - response plans lose their references to deleted items and go `stale`;
 *  - the Postbox clarification questions lose their item links;
 *  - the brief row: deletion epoch and interpretation revision bumped (an
 *    in-flight run gets `erased`), overview cache dropped, completeness
 *    recomputed, a checkpoint naming the message cleared;
 *  - `mailThreads.briefTop` recomputed, its "Latest update" line cleared when
 *    the purged message had been interpreted (the line may have come from it).
 *
 * An item's wording is kept while another message still evidences it: the
 * claim survives on that evidence, and rewording it would need the model.
 *
 * Items and facts are found by scanning the thread (evidence is an array and
 * cannot be indexed). A thread holds far fewer than {@link CLAIM_SCAN_LIMIT}
 * of either; a larger one is finished by `sweepSourcesPage`, a paginated
 * continuation.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { scopedIdempotencyKey } from './activity';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import {
	deleteExtractions,
	NO_METER,
	recomputeCompleteness,
	unlinkDeletedItem,
	type PurgeMeter,
} from './purgeRows';
import { recordItemChange, writeItemChange } from './counters';

/** Items or facts scanned inline per thread. */
export const CLAIM_SCAN_LIMIT = 1000;
/** Rows of one source read per range (extractions, activity). */
const SOURCE_ROW_LIMIT = 256;
/** Response plans of one thread rewritten inline. */
const PLAN_LIMIT = 200;
/** Page of the continuation sweep. */
const SWEEP_PAGE = 200;

export type ClaimTable = 'threadItems' | 'threadFacts';

/**
 * Activity key families the send pipeline (`sendActivity.ts`) writes per
 * message or send id: `<family>:<id>` or `<family>:<id>:<detail>`.
 */
const SEND_EVENT_KEYS = ['sent', 'delivery_failed', 'send_queued', 'send_cancelled', 'send_held'];

interface ClaimOutcome {
	deletedItemIds: Set<string>;
	deletedFactIds: Set<string>;
	changed: number;
}

/** The interpretation sources a purged Postbox message can be: received or sent. */
export function mailMessageSources(messageId: Id<'mailMessages'>): InterpretationSource[] {
	return [
		{ kind: 'mail', id: messageId },
		{ kind: 'outboundMail', id: messageId },
	];
}

/**
 * Remove what `sources` contributed to one thread's brief (see the module
 * doc). `meter` charges the reads to an erasure walker's budget.
 */
export async function purgeSourcesFromThread(
	ctx: MutationCtx,
	ref: ThreadRef,
	sources: readonly InterpretationSource[],
	meter: PurgeMeter = NO_METER
): Promise<void> {
	if (sources.length === 0) return;
	const ids = new Set<string>(sources.map((s) => s.id));
	const keys = new Set(sources.map(interpretationSourceKey));

	const hadInterpretation = await deleteSourceRows(ctx, ref, sources, meter);

	const outcome: ClaimOutcome = {
		deletedItemIds: new Set(),
		deletedFactIds: new Set(),
		changed: 0,
	};
	for (const table of ['threadItems', 'threadFacts'] as const) {
		if (table === 'threadFacts' && ref.kind !== 'mail') continue;
		const rows = await scanClaims(ctx, ref, table, CLAIM_SCAN_LIMIT + 1);
		await stripClaims(ctx, ref, table, ids, rows.slice(0, CLAIM_SCAN_LIMIT), outcome, meter);
		if (rows.length > CLAIM_SCAN_LIMIT) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.sweepSourcesPage, {
				threadRef: ref,
				sources: [...sources],
				table,
				cursor: null,
			});
		}
	}
	await settleThread(ctx, ref, outcome, { keys, isLatestStale: hadInterpretation, meter });
}

/** Delete the source's extractions and the activity rows that name it. */
async function deleteSourceRows(
	ctx: MutationCtx,
	ref: ThreadRef,
	sources: readonly InterpretationSource[],
	meter: PurgeMeter
): Promise<boolean> {
	let hadInterpretation = false;
	const remove = async (rows: Array<{ _id: Id<'interpretSources' | 'threadActivity'> }>) => {
		for (const row of rows) {
			meter(row);
			await ctx.db.delete(row._id);
		}
	};
	for (const source of sources) {
		const key = interpretationSourceKey(source);
		const extractions = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_revision', (q) => q.eq('sourceKey', key))
			.take(SOURCE_ROW_LIMIT);
		if (extractions.length > 0) hadInterpretation = true;
		await deleteExtractions(ctx, extractions, meter);
		// The eligibility snapshot (and a team reply's sent text) of the source.
		await remove(
			await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', key))
				.take(SOURCE_ROW_LIMIT)
		);

		const received = scopedIdempotencyKey(ref, `received:${key}`);
		await remove(
			await ctx.db
				.query('threadActivity')
				.withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', received))
				.take(SOURCE_ROW_LIMIT)
		);
		const prefix = scopedIdempotencyKey(ref, `interp:${key}:`);
		await remove(
			await ctx.db
				.query('threadActivity')
				.withIndex('by_idempotency_key', (q) =>
					q.gte('idempotencyKey', prefix).lt('idempotencyKey', `${prefix}￿`)
				)
				.take(SOURCE_ROW_LIMIT)
		);
	}
	for (const id of new Set(sources.map((s) => s.id as string))) {
		await remove(
			await ctx.db
				.query('threadActivity')
				.withIndex('by_op_ref', (q) => q.eq('opRef.id', id))
				.take(SOURCE_ROW_LIMIT)
		);
		// The send pipeline's rows keyed by the message (or send) id, some without an opRef.
		for (const family of SEND_EVENT_KEYS) {
			const exact = scopedIdempotencyKey(ref, `${family}:${id}`);
			await remove(
				await ctx.db
					.query('threadActivity')
					.withIndex('by_idempotency_key', (q) =>
						q.gte('idempotencyKey', exact).lte('idempotencyKey', `${exact}:\uffff`)
					)
					.take(SOURCE_ROW_LIMIT)
			);
		}
	}
	return hadInterpretation;
}

type ClaimRow = Doc<'threadItems'> | Doc<'threadFacts'>;

function scanClaims(
	ctx: MutationCtx,
	ref: ThreadRef,
	table: ClaimTable,
	limit: number
): Promise<ClaimRow[]> {
	if (table === 'threadFacts') {
		return ref.kind === 'mail'
			? ctx.db
					.query('threadFacts')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', ref.id))
					.take(limit)
			: Promise.resolve([]);
	}
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', ref.id))
				.take(limit)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) => q.eq('conversationThreadId', ref.id))
				.take(limit);
}

/**
 * Drop the evidence that names a purged source from `rows`; delete the claims
 * left without any, then repair the survivors' pointers to them.
 */
async function stripClaims(
	ctx: MutationCtx,
	ref: ThreadRef,
	table: ClaimTable,
	ids: ReadonlySet<string>,
	rows: readonly ClaimRow[],
	outcome: ClaimOutcome,
	meter: PurgeMeter
): Promise<void> {
	const now = Date.now();
	const deleted = table === 'threadItems' ? outcome.deletedItemIds : outcome.deletedFactIds;
	const survivors: ClaimRow[] = [];
	const doomed: ClaimRow[] = [];
	for (const row of rows) {
		meter(row);
		if (!row.evidence.some((e) => ids.has(e.source.id))) {
			survivors.push(row);
			continue;
		}
		const evidence = row.evidence.filter((e) => !ids.has(e.source.id));
		if (evidence.length === 0) {
			doomed.push(row);
			deleted.add(row._id);
			continue;
		}
		await ctx.db.patch(row._id, { evidence, revision: row.revision + 1, updatedAt: now });
		survivors.push({ ...row, evidence, revision: row.revision + 1 });
		outcome.changed += 1;
	}
	for (const row of doomed) {
		if (table === 'threadItems') {
			await unlinkDeletedItem(ctx, row._id as Id<'threadItems'>, meter);
			// The brief's item counters (`counters.ts`) lose it.
			await recordItemChange(ctx, ref, row as Doc<'threadItems'>, null);
		}
		await ctx.db.delete(row._id);
	}
	for (const row of survivors) {
		const patch = repairPointers(row, deleted, table, doomed);
		if (!patch) continue;
		const stamp = { revision: row.revision + 1, updatedAt: now };
		if (table === 'threadItems') {
			// A reopened item moves its list bucket and counters; briefTop is refreshed at the end.
			const itemPatch: Partial<Doc<'threadItems'>> = {
				...(patch as Partial<Doc<'threadItems'>>),
				...stamp,
			};
			await writeItemChange(ctx, ref, row as Doc<'threadItems'>, itemPatch);
		} else {
			const factPatch: Partial<Doc<'threadFacts'>> = {
				...(patch as Partial<Doc<'threadFacts'>>),
				...stamp,
			};
			await ctx.db.patch(row._id as Id<'threadFacts'>, factPatch);
		}
		outcome.changed += 1;
	}
}

/**
 * The patch that clears a survivor's pointers to deleted claims. An item
 * replaced by a deleted item is open again; a fact superseded by a deleted
 * fact is current again: the claim that retired it is gone. Pure.
 */
export function repairPointers(
	row: ClaimRow,
	deleted: ReadonlySet<string>,
	table: ClaimTable,
	doomed: readonly ClaimRow[]
): Partial<Doc<'threadItems'>> | Partial<Doc<'threadFacts'>> | null {
	if (table === 'threadItems') {
		const item = row as Doc<'threadItems'>;
		const patch: Partial<Doc<'threadItems'>> = {};
		if (item.replacedById && deleted.has(item.replacedById)) {
			patch.replacedById = undefined;
			if (item.status === 'superseded') patch.status = 'open';
		}
		if (item.possibleDuplicateOfId && deleted.has(item.possibleDuplicateOfId)) {
			patch.possibleDuplicateOfId = undefined;
		}
		return Object.keys(patch).length > 0 ? patch : null;
	}
	const fact = row as Doc<'threadFacts'>;
	const patch: Partial<Doc<'threadFacts'>> = {};
	if (fact.supersedesId && deleted.has(fact.supersedesId)) patch.supersedesId = undefined;
	if (fact.conflictsWithId && deleted.has(fact.conflictsWithId)) patch.conflictsWithId = undefined;
	const isRetiredByDeleted = doomed.some(
		(d) => (d as Doc<'threadFacts'>).supersedesId === fact._id
	);
	if (isRetiredByDeleted && fact.status === 'superseded') patch.status = 'current';
	return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * After claims moved: plans and clarification links, the brief row, the list
 * projection.
 */
async function settleThread(
	ctx: MutationCtx,
	ref: ThreadRef,
	outcome: ClaimOutcome,
	opts: { keys: ReadonlySet<string>; isLatestStale: boolean; meter: PurgeMeter }
): Promise<void> {
	const hasClaimChange =
		outcome.changed > 0 || outcome.deletedItemIds.size > 0 || outcome.deletedFactIds.size > 0;
	if (hasClaimChange) await stalePlans(ctx, ref, outcome.deletedItemIds, opts.meter);
	if (ref.kind === 'mail' && outcome.deletedItemIds.size > 0) {
		await unlinkClarification(ctx, ref.id, outcome.deletedItemIds);
	}

	const brief = await loadBriefRow(ctx, ref);
	if (!brief) {
		if (ref.kind === 'mail') await clearBriefTop(ctx, ref.id);
		return;
	}
	opts.meter(brief);
	const completeness = await recomputeCompleteness(ctx, ref);
	const isCheckpointGone = !!brief.checkpoint && opts.keys.has(brief.checkpoint.sourceKey);
	await ctx.db.patch(brief._id, {
		deletionEpoch: brief.deletionEpoch + 1,
		interpretationRevision: brief.interpretationRevision + 1,
		overview: undefined,
		completeness,
		...(isCheckpointGone ? { checkpoint: undefined } : {}),
		updatedAt: Date.now(),
	});
	if (ref.kind === 'mail') {
		await refreshBriefTop(ctx, ref.id, opts.isLatestStale ? { latest: null } : {});
	}
}

/** Strip deleted items from the thread's response plans and mark every plan stale. */
async function stalePlans(
	ctx: MutationCtx,
	ref: ThreadRef,
	deleted: ReadonlySet<string>,
	meter: PurgeMeter
): Promise<void> {
	const plans =
		ref.kind === 'mail'
			? await ctx.db
					.query('draftResponsePlans')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
					.take(PLAN_LIMIT)
			: await ctx.db
					.query('draftResponsePlans')
					.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
					.take(PLAN_LIMIT);
	for (const plan of plans) {
		meter(plan);
		await ctx.db.patch(plan._id, stripPlan(plan, deleted));
	}
}

/** A plan without its references to deleted items, marked stale. Pure. */
export function stripPlan(
	plan: Pick<Doc<'draftResponsePlans'>, 'itemRevisions' | 'stances' | 'ownerInputs' | 'coverage'>,
	deleted: ReadonlySet<string>
) {
	const keep = (entry: { itemId: string }) => !deleted.has(entry.itemId);
	return {
		itemRevisions: plan.itemRevisions.filter(keep),
		stances: plan.stances.filter(keep),
		ownerInputs: plan.ownerInputs.map((input) =>
			input.itemId && deleted.has(input.itemId) ? { questionId: input.questionId } : input
		),
		coverage: plan.coverage.filter(keep),
		verdict: 'stale' as const,
		updatedAt: Date.now(),
	};
}

/** Clear the item links of the Postbox clarification questions on the thread. */
async function unlinkClarification(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	deleted: ReadonlySet<string>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	const clarification = thread?.needsReply?.clarification;
	if (!thread?.needsReply || !clarification) return;
	if (!clarification.questions.some((q) => q.itemId && deleted.has(q.itemId))) return;
	const questions = clarification.questions.map(({ itemId, ...question }) =>
		itemId && deleted.has(itemId) ? question : { ...question, ...(itemId ? { itemId } : {}) }
	);
	await ctx.db.patch(threadId, {
		needsReply: { ...thread.needsReply, clarification: { ...clarification, questions } },
	});
}

/** A thread with no brief row keeps no projection of one. */
async function clearBriefTop(ctx: MutationCtx, threadId: Id<'mailThreads'>): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (thread?.briefTop) await ctx.db.patch(threadId, { briefTop: undefined });
}

/**
 * Continuation of {@link purgeSourcesFromThread} for a thread with more than
 * {@link CLAIM_SCAN_LIMIT} items or facts: one page of `table`, then the next.
 * Re-reading the rows the inline pass handled is harmless (they no longer
 * name the source).
 */
/** The arguments of {@link sweepSourcesPage} (validated in `purgeJobs.ts`). */
export interface SweepSourcesArgs {
	threadRef: ThreadRef;
	sources: InterpretationSource[];
	table: ClaimTable;
	cursor: string | null;
}

export async function sweepSourcesPage(
	ctx: MutationCtx,
	args: SweepSourcesArgs
): Promise<{ isDone: boolean }> {
	const ref = args.threadRef;
	const query =
		args.table === 'threadFacts'
			? ref.kind === 'mail'
				? ctx.db
						.query('threadFacts')
						.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', ref.id))
				: null
			: ref.kind === 'mail'
				? ctx.db
						.query('threadItems')
						.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', ref.id))
				: ctx.db
						.query('threadItems')
						.withIndex('by_conversation_thread_and_status', (q) =>
							q.eq('conversationThreadId', ref.id)
						);
	if (!query) return { isDone: true };
	const page = await query.paginate({ cursor: args.cursor, numItems: SWEEP_PAGE });
	const outcome: ClaimOutcome = {
		deletedItemIds: new Set(),
		deletedFactIds: new Set(),
		changed: 0,
	};
	const ids = new Set<string>(args.sources.map((s) => s.id));
	await stripClaims(ctx, ref, args.table, ids, page.page, outcome, NO_METER);
	await settleThread(ctx, ref, outcome, {
		keys: new Set(args.sources.map(interpretationSourceKey)),
		isLatestStale: false,
		meter: NO_METER,
	});
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.sweepSourcesPage, {
			...args,
			cursor: page.continueCursor,
		});
	}
	return { isDone: page.isDone };
}
