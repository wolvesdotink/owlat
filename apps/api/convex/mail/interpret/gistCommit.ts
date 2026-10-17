/**
 * Read on arrival (SPEC §2.4, §2.5): the gist's commit, the one write of a
 * gist read. In one transaction it checks that the run still holds the
 * source's lease, that no purge ran since the run's load (the brief's
 * deletion epoch) and that the thread is neither fenced nor shared now; then
 * it seals and stores the gist (`threadBriefs.gist`, and the list row's line
 * `briefTop.gist`), settles the source as gist-only (upgradeable, lease
 * cleared) and records the depth on the arrival record, which recomputes the
 * projection.
 *
 * One gist per thread: a gist of an older message never replaces a newer
 * one's (the source settles either way). The commit also rechecks the body
 * fingerprint the gist read (`sourceVersion`, Sol r1 F6): quotes from an
 * earlier body are never stored.
 *
 * {@link retryGist}: a gist whose model call failed transiently is tried
 * again on `retry.ts`'s schedule (Sol r1 F12), counting the record's model
 * calls as its attempts; past the last one it counts (`gistFailed`).
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { isPersonalMailbox } from '../permissions';
import { loadArrivalRecord, noteArrivalRun } from '../arrival/records';
import { ensureBriefRow } from './briefRow';
import { setBriefTopGist } from './briefTop';
import { gistTopText } from './gistState';
import { leaseLostAt } from './lease';
import { settleArrivalSource } from './outstanding';
import { loadInterpretSource } from './sources';
import { isFencedThread } from './staleFence';
import { sourceVersionOf } from './sourceVersion';
import { nextRetryAtOf } from './retry';
import { internal } from '../../_generated/api';
import {
	ARRIVAL_ADMISSION_REASONS,
	isSettlementCurrent,
	refusedCount,
	settleArrivalSkip,
} from './arrivalDecide';

export type GistCommit =
	| { kind: 'committed' }
	/** Settled as a count instead: the thread is fenced now. */
	| { kind: 'counted' }
	/** The body changed since the gist read it: read again (Sol r1 F6). */
	| { kind: 'sourceChanged' }
	| { kind: 'busy'; retryAt: number }
	/** The message is gone, purged since the load, or its mailbox is shared now. */
	| { kind: 'gone' };

const spanValidator = v.object({ segmentId: v.string(), quote: v.string() });

/** Whether the stored gist was read from a message after `sourceOrderKey` (then it stays). */
async function isNewerGistStored(
	ctx: Pick<MutationCtx, 'db'>,
	stored: { sourceKey: string } | undefined,
	sourceKey: string,
	sourceOrderKey: string | undefined
): Promise<boolean> {
	if (!stored || stored.sourceKey === sourceKey) return false;
	const other = await ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', stored.sourceKey))
		.first();
	return (other?.sourceOrderKey ?? '') > (sourceOrderKey ?? '');
}

export const commitGist = internalMutation({
	args: {
		source: v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
		leaseToken: v.optional(v.string()),
		deletionEpoch: v.number(),
		/** The body fingerprint the gist read (`scopedInput.ts`); the commit rechecks it. */
		sourceVersion: v.optional(v.string()),
		gist: v.object({
			spans: v.array(spanValidator),
			fact: v.optional(v.object({ kind: v.string(), quote: v.string() })),
			gistVersion: v.number(),
		}),
	},
	handler: async (ctx, args): Promise<GistCommit> => {
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!row || !message) return { kind: 'gone' };
		const lostAt = await leaseLostAt(ctx, args.source, args.leaseToken);
		if (lostAt !== null) return { kind: 'busy', retryAt: lostAt };
		const thread = await ctx.db.get(message.threadId);
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!thread || !mailbox) return { kind: 'gone' };
		// A team inbox now: nothing of read on arrival is written (Sol r1 F5).
		if (!isPersonalMailbox(mailbox)) return { kind: 'gone' };
		const ref = { kind: 'mail' as const, id: thread._id };
		const brief = await ensureBriefRow(ctx, ref);
		if (!brief || brief.deletionEpoch !== args.deletionEpoch) return { kind: 'gone' };
		if ((await sourceVersionOf(ctx, args.source)) !== (args.sourceVersion ?? null)) {
			return { kind: 'sourceChanged' };
		}
		// A record would rebuild what the fence hides.
		if (isFencedThread(thread)) {
			const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.gistUnavailable });
			await settleArrivalSkip(ctx, row, message._id, choice);
			return { kind: 'counted' };
		}
		const now = Date.now();
		if (!(await isNewerGistStored(ctx, brief.gist, row.sourceKey, row.sourceOrderKey))) {
			const spans = await Promise.all(
				args.gist.spans.map(async (s) => ({
					segmentId: s.segmentId,
					quote: await sealBodyAtWrite(s.quote),
				}))
			);
			const fact = args.gist.fact
				? { kind: args.gist.fact.kind, quote: await sealBodyAtWrite(args.gist.fact.quote) }
				: undefined;
			await ctx.db.patch(brief._id, {
				gist: {
					spans,
					...(fact ? { fact } : {}),
					sourceKey: row.sourceKey,
					gistVersion: args.gist.gistVersion,
					generatedAt: now,
				},
			});
			await setBriefTopGist(
				ctx,
				thread,
				{
					text: await sealBodyAtWrite(gistTopText(args.gist.spans)),
					...(fact ? { factQuote: fact.quote } : {}),
				},
				brief.interpretationRevision
			);
		}
		await settleArrivalSource(ctx, row.sourceKey, {
			readOutcome: 'gist',
			depth: 'gist',
			isUpgradeable: true,
		});
		await noteArrivalRun(ctx, message._id, { depth: 'gist' });
		return { kind: 'committed' };
	},
});

export type GistRetry =
	| { kind: 'retry'; retryAt: number }
	| { kind: 'counted' }
	| { kind: 'gone' }
	| { kind: 'busy'; retryAt: number };

export const retryGist = internalMutation({
	args: {
		source: v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
		leaseToken: v.optional(v.string()),
		deletionEpoch: v.number(),
	},
	handler: async (ctx, args): Promise<GistRetry> => {
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!row || !message) return { kind: 'gone' };
		const lostAt = await leaseLostAt(ctx, args.source, args.leaseToken);
		if (lostAt !== null) return { kind: 'busy', retryAt: lostAt };
		if (!(await isSettlementCurrent(ctx, message, args.deletionEpoch))) return { kind: 'gone' };
		const record = await loadArrivalRecord(ctx, message._id);
		const now = Date.now();
		const retryAt = nextRetryAtOf(
			{ status: 'failed', errorCode: 'model_error', retryCount: record?.modelCalls ?? 1 },
			now
		);
		if (retryAt !== undefined) {
			// Still outstanding: the retry (or, failing that, the stale sweep) reads it.
			await ctx.scheduler.runAt(retryAt, internal.mail.interpret.run.interpretMessage, {
				source: args.source,
			});
			return { kind: 'retry', retryAt };
		}
		const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.gistFailed });
		await settleArrivalSkip(ctx, row, message._id, choice);
		return { kind: 'counted' };
	},
});
