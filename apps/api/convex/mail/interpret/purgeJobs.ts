/**
 * The scheduled continuations of the thread brief erasure and the scope
 * change: thin internal mutations over the helpers that schedule them (in
 * their own module, so every one has a caller outside it):
 *
 *  - `sweepSourcesPage`: a message purge in a thread with more items or facts
 *    than one pass scans (`purge.ts`);
 *  - `drainThreadBrief`: the rows of a deleted thread that did not fit inline
 *    (`purgeThread.ts`);
 *  - `invalidateMailboxThreads` / `invalidateThreadScope`: a mailbox that
 *    became a team inbox, a page of threads (or one large thread) at a time
 *    (`scopeChange.ts`).
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceValidator,
	interpretModeValidator,
} from '../../lib/validators/threadBrief';
import { threadRefValidator } from '../../lib/validators/threadRef';
import { sweepSourcesPage as sweepSources } from './purge';
import { drainThreadBrief as drainThread } from './purgeThread';
import {
	invalidateMailboxThreads as invalidateMailbox,
	invalidateThreadScope as invalidateThread,
} from './scopeChange';

export const sweepSourcesPage = internalMutation({
	args: {
		threadRef: threadRefValidator,
		sources: v.array(interpretationSourceValidator),
		table: v.union(v.literal('threadItems'), v.literal('threadFacts')),
		cursor: v.union(v.string(), v.null()),
	},
	handler: (ctx, args): Promise<{ isDone: boolean }> => sweepSources(ctx, args),
});

export const drainThreadBrief = internalMutation({
	args: { threadRef: threadRefValidator },
	handler: (ctx, args): Promise<{ isDone: boolean }> => drainThread(ctx, args),
});

export const invalidateMailboxThreads = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		mode: interpretModeValidator,
		cursor: v.union(v.string(), v.null()),
	},
	handler: (ctx, args): Promise<{ isDone: boolean; threads: number }> =>
		invalidateMailbox(ctx, args),
});

export const invalidateThreadScope = internalMutation({
	args: { threadId: v.id('mailThreads'), mode: interpretModeValidator },
	handler: (ctx, args): Promise<{ isDone: boolean }> => invalidateThread(ctx, args),
});
