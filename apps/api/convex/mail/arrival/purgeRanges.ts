/**
 * Read on arrival: what a purged message takes along (erasure).
 * These are ranges of the resumable `sources` purge job
 * (`mail/interpret/purge.ts sourcesPlan`, appended after its own ranges), so
 * they share its transaction budget and its durable cursor
 * (`mail/interpret/purgeDrain.ts`). In order:
 *
 *  1. the purged messages' lines in the mailbox's generated digest, the only
 *     state that holds item text (`digestState.ts`); the mailbox is the one
 *     persisted on the job;
 *  2. the messages' arrival records, delayed actions and undo-log change rows;
 *  3. the thread's projection when it points at a purged message, and the
 *     brief's gist when it was read from one (`briefTop.gist` with it).
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
	type PurgeRange,
	type RangeRun,
} from '../interpret/purgeDrain';
import { refreshArrivalProjection } from './projection';

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
 * Most generated digests a mailbox can hold is one (`digestState.ts`); two
 * are read so a broken invariant is seen, logged and still handled.
 */
const GENERATED_DIGEST_PROBE = 2;

/**
 * 1. The purged messages' lines in the mailbox's generated digest. Only a
 * `generated` digest holds item text (`digestState.ts`: claimed has none yet,
 * failed and sent are stripped), so this is one bounded read, no cursor.
 */
const generatedDigestRange: PurgeRange = async (ctx, run) => {
	const ids = purgedMessageIds(run);
	const mailboxId = mailboxOfRun(run);
	if (ids.length === 0 || !mailboxId) return { isDone: true };
	const purged = new Set<string>(ids);
	run.budget.range();
	const digests = await ctx.db
		.query('mailDigests')
		.withIndex('by_mailbox_state', (q) => q.eq('mailboxId', mailboxId).eq('state', 'generated'))
		.take(GENERATED_DIGEST_PROBE);
	for (const digest of digests) run.budget.charge(digest);
	if (digests.length >= GENERATED_DIGEST_PROBE) {
		console.warn('arrival: more than one generated digest in a mailbox', { mailboxId });
	}
	for (const digest of digests) {
		const items = digest.items.filter((item) => !purged.has(item.messageId));
		if (items.length !== digest.items.length) await ctx.db.patch(digest._id, { items });
		run.budget.progress();
	}
	return { isDone: true };
};

/**
 * 2. Every per-message arrival row of the purged messages, and the counted
 * draft offer a purged message was owed for (`mailDraftOfferUsage`, keyed
 * `<threadId>:<messageId>`, mail/draftPause.ts).
 */
const messageRowsRange: PurgeRange = (ctx, run) => {
	const deleting = async (row: {
		_id: Id<
			| 'mailArrivalRecords'
			| 'mailDelayedActions'
			| 'mailArrivalOperationChanges'
			| 'mailDraftOfferUsage'
		>;
	}) => {
		await ctx.db.delete(row._id);
		return true;
	};
	const mailboxId = mailboxOfRun(run);
	const threadId = run.ref.kind === 'mail' ? run.ref.id : null;
	return drainSteps(
		run.budget,
		run.cursor,
		purgedMessageIds(run).flatMap((messageId) => [
			() =>
				mailboxId && threadId
					? drainShrinking(
							run.budget,
							(n) =>
								ctx.db
									.query('mailDraftOfferUsage')
									.withIndex('by_mailbox_offer', (q) =>
										q.eq('mailboxId', mailboxId).eq('offerKey', `${threadId}:${messageId}`)
									)
									.take(n),
							deleting
						)
					: Promise.resolve(true),
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

/** 3. The thread projection and the gist, when a purged message is what they show. */
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
		// The thread's next newest inbound message (its record survives) is
		// projected at once; the purged message's record went in range 4.
		if (isArrivalPurged) await refreshArrivalProjection(ctx, threadId);
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

/**
 * A deleted Postbox thread's counted draft offers (`mailDraftOfferUsage`,
 * mail/draftPause.ts), drained in the `thread` purge job's shared budget.
 */
const threadOfferUsageRange: PurgeRange = async (ctx, run) => {
	if (run.ref.kind !== 'mail') return { isDone: true };
	const threadId = run.ref.id;
	const isEmpty = await drainShrinking(
		run.budget,
		(n) =>
			ctx.db
				.query('mailDraftOfferUsage')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.take(n),
		async (row) => {
			await ctx.db.delete(row._id);
			return true;
		}
	);
	return isEmpty ? { isDone: true } : { isDone: false, cursor: undefined };
};

/** The read-on-arrival ranges of a `thread` purge job, appended after the brief's. */
export const arrivalThreadRanges: readonly PurgeRange[] = [threadOfferUsageRange];

/** The read-on-arrival ranges of a `sources` purge job, in order. */
export const arrivalSourceRanges: readonly PurgeRange[] = [
	generatedDigestRange,
	messageRowsRange,
	projectionRange,
];

/**
 * A purged source's `interpretSources` row is about to be deleted: a gist-only
 * or skipped outcome no longer counts in the brief.
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
