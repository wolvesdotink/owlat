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
 * one's (the source settles either way).
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { isPersonalMailbox } from '../permissions';
import { noteArrivalRun } from '../arrival/records';
import { ensureBriefRow } from './briefRow';
import { setBriefTopGist } from './briefTop';
import { gistTopText } from './gistState';
import { leaseLostAt } from './lease';
import { settleArrivalSource } from './outstanding';
import { loadInterpretSource } from './sources';
import { isFencedThread } from './staleFence';
import { ARRIVAL_ADMISSION_REASONS, refusedCount, settleArrivalSkip } from './arrivalDecide';

export type GistCommit =
	| { kind: 'committed' }
	/** Settled as a count instead: the thread is fenced or shared now. */
	| { kind: 'counted' }
	| { kind: 'busy'; retryAt: number }
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
		const ref = { kind: 'mail' as const, id: thread._id };
		const brief = await ensureBriefRow(ctx, ref);
		if (!brief || brief.deletionEpoch !== args.deletionEpoch) return { kind: 'gone' };
		// A record would rebuild what the fence hides; a shared mailbox shows no gist.
		if (isFencedThread(thread) || !isPersonalMailbox(mailbox)) {
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
