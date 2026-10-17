/**
 * Read on arrival: what a purged message takes along (SPEC §0 "erasure",
 * §2.9). These are ranges of the resumable `sources` purge job
 * (`mail/interpret/purge.ts sourcesPlan`, appended after its own ranges), so
 * they share its transaction budget and its durable cursor
 * (`mail/interpret/purgeDrain.ts`). In order:
 *
 *  1–3. the purged messages' lines in every unsent digest of the mailbox
 *       (`claimed`, `generated`, `failed`), walked by creation time;
 *  4.   the messages' arrival records, delayed actions and undo-log change rows;
 *  5.   the thread's projection when it points at a purged message, and the
 *       brief's gist when it was read from one (`briefTop.gist` with it).
 *
 * `releaseArrivalSourceAccounting` is called by the job's snapshot range as it
 * deletes a purged source's `interpretSources` row: a gist-only or skipped
 * outcome leaves the brief's `gistSources` / `skippedSources` count.
 *
 * Mailbox-wide deletions (member erasure, an external teardown, the
 * organization wipe, a team-inbox conversion) remove arrival rows by mailbox
 * instead (`mailboxRows.ts`).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import {
	drainShrinking,
	drainSteps,
	scanRange,
	type PurgeRange,
	type RangeRun,
} from '../interpret/purgeDrain';

/** The purged Postbox messages of a `sources` job (received and sent sources share an id). */
function purgedMessageIds(run: RangeRun): Id<'mailMessages'>[] {
	const ids = new Set<Id<'mailMessages'>>();
	for (const source of run.state.sources) {
		if (source.kind === 'mail' || source.kind === 'outboundMail') ids.add(source.id);
	}
	return [...ids];
}

/**
 * The mailbox the purged messages belonged to: the thread's, or, once the
 * thread is gone too, a purged message's arrival record's (those ranges come
 * later, so the records are still there). Null when neither is left: a message
 * with no record never reached a digest.
 */
async function mailboxOfRun(
	ctx: MutationCtx,
	run: RangeRun,
	ids: readonly Id<'mailMessages'>[]
): Promise<Id<'mailboxes'> | null> {
	if (run.ref.kind !== 'mail') return null;
	run.budget.range();
	const thread = await ctx.db.get(run.ref.id);
	run.budget.charge(thread);
	if (thread) return thread.mailboxId;
	for (const messageId of ids) {
		run.budget.range();
		const record = await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first();
		run.budget.charge(record);
		if (record) return record.mailboxId;
	}
	return null;
}

/** One unsent digest state: drop the purged messages' lines, walked by creation time. */
function unsentDigestRange(state: 'claimed' | 'generated' | 'failed'): PurgeRange {
	return async (ctx, run) => {
		const ids = purgedMessageIds(run);
		if (ids.length === 0) return { isDone: true };
		const mailboxId = await mailboxOfRun(ctx, run, ids);
		if (!mailboxId) return { isDone: true };
		const purged = new Set<string>(ids);
		return scanRange(
			run.budget,
			run.cursor,
			(after, n) =>
				ctx.db
					.query('mailDigests')
					.withIndex('by_mailbox_state', (q) =>
						typeof after === 'number'
							? q.eq('mailboxId', mailboxId).eq('state', state).gt('_creationTime', after)
							: q.eq('mailboxId', mailboxId).eq('state', state)
					)
					.take(n),
			(digest) => digest._creationTime,
			async (digest) => {
				const items = digest.items.filter((item) => !purged.has(item.messageId));
				if (items.length !== digest.items.length) await ctx.db.patch(digest._id, { items });
				return true;
			}
		);
	};
}

/** 4. Every per-message arrival row of the purged messages. */
const messageRowsRange: PurgeRange = (ctx, run) => {
	const deleting = async (row: {
		_id: Id<'mailArrivalRecords' | 'mailDelayedActions' | 'mailArrivalOperationChanges'>;
	}) => {
		await ctx.db.delete(row._id);
		return true;
	};
	return drainSteps(
		run.budget,
		run.cursor,
		purgedMessageIds(run).flatMap((messageId) => [
			() =>
				drainShrinking(
					run.budget,
					(n) =>
						ctx.db
							.query('mailArrivalRecords')
							.withIndex('by_message', (q) => q.eq('messageId', messageId))
							.take(n),
					deleting
				),
			() =>
				drainShrinking(
					run.budget,
					(n) =>
						ctx.db
							.query('mailDelayedActions')
							.withIndex('by_message', (q) => q.eq('messageId', messageId))
							.take(n),
					deleting
				),
			() =>
				drainShrinking(
					run.budget,
					(n) =>
						ctx.db
							.query('mailArrivalOperationChanges')
							.withIndex('by_message', (q) => q.eq('messageId', messageId))
							.take(n),
					deleting
				),
		])
	);
};

/** 5. The thread projection and the gist, when a purged message is what they show. */
const projectionRange: PurgeRange = async (ctx, run) => {
	if (run.ref.kind !== 'mail') return { isDone: true };
	const threadId = run.ref.id;
	const ids = new Set<string>(purgedMessageIds(run));
	const keys = new Set(run.state.sources.map(interpretationSourceKey));
	run.budget.range();
	const thread = await ctx.db.get(threadId);
	run.budget.charge(thread);
	if (thread) {
		const isArrivalPurged = thread.arrival !== undefined && ids.has(thread.arrival.messageId);
		const brief = await loadMailBrief(ctx, threadId);
		const isGistPurged = brief?.gist !== undefined && keys.has(brief.gist.sourceKey);
		if (isArrivalPurged || (isGistPurged && thread.briefTop?.gist)) {
			await ctx.db.patch(threadId, {
				...(isArrivalPurged ? { arrival: undefined, digestPendingSince: undefined } : {}),
				...(isGistPurged && thread.briefTop
					? { briefTop: { ...thread.briefTop, gist: undefined } }
					: {}),
			});
		}
		if (brief && isGistPurged) {
			await ctx.db.patch(brief._id, { gist: undefined, updatedAt: Date.now() });
		}
		run.budget.progress();
	}
	return { isDone: true };
};

async function loadMailBrief(
	ctx: MutationCtx,
	mailThreadId: Id<'mailThreads'>
): Promise<Doc<'threadBriefs'> | null> {
	return ctx.db
		.query('threadBriefs')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', mailThreadId))
		.unique();
}

/** The read-on-arrival ranges of a `sources` purge job, in order. */
export const arrivalSourceRanges: readonly PurgeRange[] = [
	unsentDigestRange('claimed'),
	unsentDigestRange('generated'),
	unsentDigestRange('failed'),
	messageRowsRange,
	projectionRange,
];

/**
 * A purged source's `interpretSources` row is about to be deleted: a gist-only
 * or skipped outcome no longer counts in the brief (SPEC §2.5).
 */
export async function releaseArrivalSourceAccounting(
	ctx: MutationCtx,
	ref: ThreadRef,
	source: Pick<Doc<'interpretSources'>, 'readOutcome'>
): Promise<void> {
	if (ref.kind !== 'mail' || source.readOutcome === undefined) return;
	const brief = await loadMailBrief(ctx, ref.id);
	if (!brief) return;
	if (source.readOutcome === 'gist') {
		await ctx.db.patch(brief._id, { gistSources: Math.max(0, (brief.gistSources ?? 0) - 1) });
	} else {
		await ctx.db.patch(brief._id, {
			skippedSources: Math.max(0, (brief.skippedSources ?? 0) - 1),
		});
	}
}
