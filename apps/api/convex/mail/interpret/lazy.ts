/**
 * Lazy interpretation on first open (ADR-0072, D5): a thread older than the
 * 30-day backfill, or one the backfill has not reached, has no brief. When
 * the reader opens it, `brief.get` answers `completeness: 'none'` and the web
 * shows the Conversation and calls {@link ensure}, which hands the thread's
 * newest messages to interpretation (`backfillSources.ts`, bounded to
 * `MESSAGES_PER_THREAD`). The brief turns `pending`, then fills in through
 * the live `brief.get` subscription.
 *
 * Idempotent: a thread whose brief exists (pending, partial or complete) is
 * left alone, and a message already snapshotted is never scheduled twice. It
 * runs nothing when the interpretation gate refuses (the `ai` flag or the
 * spend budget) and takes a per-user rate limit, because any reader can call
 * it for any thread they can open.
 */

import { threadBriefMutation } from '../_helpers';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import { rateLimiter } from '../../lib/rateLimiter';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { requireThreadReader } from './threadAccess';
import { loadBriefRow } from './briefRow';
import { modeOfMailbox } from './briefTop';
import { interpretGate } from './gate';
import { enqueueThreadInterpretation } from './backfillSources';

type EnsureOutcome =
	| { isEnqueued: true; runs: number }
	| { isEnqueued: false; reason: 'has_brief' | 'nothing_to_read' | 'ai_off' | 'budget' | 'busy' };

async function modeOf(ctx: MutationCtx, ref: ThreadRef): Promise<InterpretMode | null> {
	if (ref.kind === 'team') return 'actions';
	const thread = await ctx.db.get(ref.id);
	const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
	return mailbox ? modeOfMailbox(mailbox) : null;
}

export const ensure = threadBriefMutation({
	args: { threadRef: threadRefValidator },
	handler: async (ctx, args, session): Promise<EnsureOutcome> => {
		// authz: requireThreadReader applies the thread's reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		await requireThreadReader(ctx, args.threadRef, session);
		const brief = await loadBriefRow(ctx, args.threadRef);
		if (brief && brief.completeness !== 'none') return { isEnqueued: false, reason: 'has_brief' };
		const mode = await modeOf(ctx, args.threadRef);
		if (!mode) return { isEnqueued: false, reason: 'nothing_to_read' };
		const gate = await interpretGate(ctx, mode);
		if (!gate.isAllowed) return { isEnqueued: false, reason: gate.code };
		const limited = await rateLimiter.limit(ctx, 'briefEnsurePerUser', { key: session.userId });
		if (!limited.ok) return { isEnqueued: false, reason: 'busy' };
		const runs = await enqueueThreadInterpretation(ctx, args.threadRef);
		return runs > 0 ? { isEnqueued: true, runs } : { isEnqueued: false, reason: 'nothing_to_read' };
	},
});
