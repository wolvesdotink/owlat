/**
 * Lazy interpretation on first open (ADR-0072, D5): a thread older than the
 * 30-day backfill, or one the backfill has not reached, has no brief. When
 * the reader opens it, `brief.get` answers `completeness: 'none'` and the web
 * shows the Conversation and calls {@link ensure}, which starts reading the
 * thread's history (`backfillSources.ts`: newest page now, the rest chained,
 * the brief partial until every page is admitted). The brief turns
 * `pending`, then fills in through the live `brief.get` subscription.
 *
 * D10: a mail thread whose sources were deferred until it is opened
 * (`defer.ts`; `brief.get` reports `deferredSources`) has them read here,
 * also when its history was read through long ago, behind the same gate and
 * rate limit: the newest deferred source is scheduled, and its run reads the
 * older ones first, in order. While another run of the thread is in flight
 * the answer is `running` (that run reads them, or the next ask does).
 *
 * Idempotent: a history read through (`has_brief`) or still moving
 * (`running`) is left alone, and a stalled one resumes from its cursor. It
 * runs nothing when the interpretation gate refuses (the `ai` flag or the
 * spend budget) and takes a per-user rate limit, because any reader can call
 * it for any thread they can open.
 */

import { threadBriefMutation } from '../_helpers';
import { threadRefValidator } from '../../lib/validators/threadRef';
import { rateLimiter } from '../../lib/rateLimiter';
import { requireThreadReader } from './threadAccess';
import { loadBriefRow } from './briefRow';
import { interpretGate } from './gate';
import { enqueueHistoryPage, isHistoryRunning } from './backfillSources';
import { activeModeOf } from './backfill';
import { hasDeferredSources, resumeDeferredSources } from './defer';

export type EnsureOutcome =
	| { isEnqueued: true; runs: number }
	| {
			isEnqueued: false;
			reason: 'has_brief' | 'running' | 'nothing_to_read' | 'ai_off' | 'budget' | 'busy';
	  };

export const ensure = threadBriefMutation({
	args: { threadRef: threadRefValidator },
	handler: async (ctx, args, session): Promise<EnsureOutcome> => {
		// authz: requireThreadReader applies the thread's reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		await requireThreadReader(ctx, args.threadRef, session);
		const brief = await loadBriefRow(ctx, args.threadRef);
		// D10: sources deferred until an open run now, even when the history was
		// read through long ago.
		if (args.threadRef.kind === 'mail' && hasDeferredSources(brief)) {
			// A run already in flight reads the deferred sources before it (defer.ts);
			// starting a second reader beside it would read them twice.
			if ((brief?.pendingSources ?? 0) > 0) return { isEnqueued: false, reason: 'running' };
			const mode = await activeModeOf(ctx, args.threadRef);
			const gate = mode ? await interpretGate(ctx, mode) : null;
			if (gate && !gate.isAllowed) return { isEnqueued: false, reason: gate.code };
			const limited = await rateLimiter.limit(ctx, 'briefEnsurePerUser', { key: session.userId });
			if (!limited.ok) return { isEnqueued: false, reason: 'busy' };
			const resumed = await resumeDeferredSources(ctx, args.threadRef);
			const history =
				brief?.historyState === 'done' || isHistoryRunning(brief, Date.now())
					? { scheduled: 0 }
					: await enqueueHistoryPage(ctx, args.threadRef);
			return { isEnqueued: true, runs: resumed + history.scheduled };
		}
		if (brief?.historyState === 'done') {
			return {
				isEnqueued: false,
				reason: brief.completeness === 'none' ? 'nothing_to_read' : 'has_brief',
			};
		}
		if (isHistoryRunning(brief, Date.now())) return { isEnqueued: false, reason: 'running' };
		const mode = await activeModeOf(ctx, args.threadRef);
		if (!mode) return { isEnqueued: false, reason: 'nothing_to_read' };
		const gate = await interpretGate(ctx, mode);
		if (!gate.isAllowed) return { isEnqueued: false, reason: gate.code };
		const limited = await rateLimiter.limit(ctx, 'briefEnsurePerUser', { key: session.userId });
		if (!limited.ok) return { isEnqueued: false, reason: 'busy' };
		const outcome = await enqueueHistoryPage(ctx, args.threadRef);
		if (outcome.scheduled > 0 || !outcome.isDone) {
			return { isEnqueued: true, runs: outcome.scheduled };
		}
		return { isEnqueued: false, reason: 'nothing_to_read' };
	},
});
