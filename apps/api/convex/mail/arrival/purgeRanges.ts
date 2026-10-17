/**
 * Read on arrival: what a purged message takes along (SPEC §0 "erasure",
 * §2.9). These are ranges of the resumable `sources` purge job
 * (`mail/interpret/purge.ts sourcesPlan`, appended after its own ranges), so
 * they share its transaction budget and its durable cursor
 * (`mail/interpret/purgeDrain.ts`). In order:
 *
 *  1–3. the purged messages' lines in every unsent digest of the mailbox
 *       (`claimed`, `generated`, `failed`), walked by creation time with a
 *       tie-safe cursor; the mailbox is the one persisted on the job;
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
	DRAIN_CHUNK,
	drainShrinking,
	drainSteps,
	type PurgeRange,
	type RangeOutcome,
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
 * The mailbox the purged messages belonged to, persisted on the job when it
 * started (`purgeRun.ts purgeSourcesFromThread`), so neither the thread nor an
 * arrival record has to outlive the walk. A job without one (a Team Inbox
 * thread) has no digests.
 */
function mailboxOfRun(run: RangeRun): Id<'mailboxes'> | null {
	return run.ref.kind === 'mail' ? (run.job.mailboxId ?? null) : null;
}

/**
 * Walk one unsent digest state of the mailbox by `_creationTime`, which rows
 * can share: the cursor keeps the last position and the ids already handled
 * there (`tieIds`), the next read starts AT that position and skips them. A
 * handled digest keeps its index position (only `items` changes).
 */
async function scanUnsentDigests(
	ctx: MutationCtx,
	run: RangeRun,
	mailboxId: Id<'mailboxes'>,
	state: 'claimed' | 'generated' | 'failed',
	handle: (digest: Doc<'mailDigests'>) => Promise<void>
): Promise<RangeOutcome> {
	let at = run.cursor?.at;
	let ties = new Set<string>(run.cursor?.tieIds ?? []);
	const save = (): RangeOutcome => ({
		isDone: false,
		cursor: {
			...(at !== undefined ? { at } : {}),
			...(ties.size > 0 ? { tieIds: [...ties] } : {}),
		},
	});
	for (;;) {
		if (run.budget.isExhausted()) return save();
		const asked = run.budget.chunk(DRAIN_CHUNK);
		// Ask past the skipped ties, so a short read still means the end.
		const limit = asked + ties.size;
		const from = at;
		run.budget.range();
		const rows = await ctx.db
			.query('mailDigests')
			.withIndex('by_mailbox_state', (q) =>
				from === undefined
					? q.eq('mailboxId', mailboxId).eq('state', state)
					: q.eq('mailboxId', mailboxId).eq('state', state).gte('_creationTime', from)
			)
			.take(limit);
		for (const row of rows) run.budget.charge(row);
		const fresh = rows.filter((row) => !(row._creationTime === from && ties.has(row._id)));
		const batch = fresh.slice(0, asked);
		for (const digest of batch) {
			await handle(digest);
			run.budget.progress();
			if (digest._creationTime !== at) {
				at = digest._creationTime;
				ties = new Set();
			}
			ties.add(digest._id);
		}
		if (rows.length < limit && fresh.length <= asked) return { isDone: true };
	}
}

/** One unsent digest state: drop the purged messages' lines. */
function unsentDigestRange(state: 'claimed' | 'generated' | 'failed'): PurgeRange {
	return async (ctx, run) => {
		const ids = purgedMessageIds(run);
		const mailboxId = mailboxOfRun(run);
		if (ids.length === 0 || !mailboxId) return { isDone: true };
		const purged = new Set<string>(ids);
		return scanUnsentDigests(ctx, run, mailboxId, state, async (digest) => {
			const items = digest.items.filter((item) => !purged.has(item.messageId));
			if (items.length !== digest.items.length) await ctx.db.patch(digest._id, { items });
		});
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
