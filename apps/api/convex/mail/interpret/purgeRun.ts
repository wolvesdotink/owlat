/**
 * Starting and driving thread brief purge jobs (`purgeDrain.ts`), the entry
 * points every purge path calls:
 *
 *  - {@link purgeSourcesFromThread}: purged source messages (Postbox purges,
 *    `mail/messagePurge.ts purgeThreadBriefsOf`);
 *  - {@link purgeThreadBrief}: a deleted thread (a Postbox thread that lost its
 *    last message, an external account's teardown);
 *  - {@link invalidateMailboxThreadsPage}: a mailbox scope change.
 *
 * Each runs the job's first slice inline, in the caller's transaction (the
 * epoch is bumped there, so in-flight interpretations stop at once), and
 * hands the rest to `purgeJobs.continueJob`, which reschedules itself until
 * every range is exhausted. The erasure walkers drive their jobs themselves
 * through {@link drivePurgeJob}, inside their own budget.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import {
	createPurgeJob,
	findPurgeJob,
	runJobPlan,
	unitBudget,
	type DrainBudget,
	type JobPlan,
	type NewPurgeJob,
	type PurgeJob,
} from './purgeDrain';
import { bumpDeletionEpoch } from './purgeRows';
import { sourcesPlan } from './purge';
import { threadPlan } from './purgeThread';
import { modeOfScope, scopePlan, startScopeChange } from './scopeChange';

/** Units a purge spends inline, in the transaction of the purge itself. */
export const INLINE_PURGE_UNITS = 400;
/** Units a scheduled continuation spends per transaction. */
export const CONTINUATION_UNITS = 2000;
/** Units a scope change spends inline per thread of a mailbox page. */
const INLINE_SCOPE_UNITS = 60;
/** Threads per mailbox page of a scope change. */
const THREAD_PAGE = 25;

function planOf(job: PurgeJob): JobPlan {
	switch (job.kind) {
		case 'sources':
			return sourcesPlan;
		case 'thread':
			return threadPlan(job.threadKind);
		case 'scope':
			return scopePlan;
	}
}

/** Run one slice of a job; true when it finished (the job row is gone). */
export async function runPurgeJob(
	ctx: MutationCtx,
	jobId: Id<'threadPurgeJobs'>,
	budget: DrainBudget
): Promise<boolean> {
	const job = await ctx.db.get(jobId);
	if (!job) return true;
	return runJobPlan(ctx, job, planOf(job), budget);
}

/** Start a job, run its first slice inline, schedule the rest. */
async function startScheduled(ctx: MutationCtx, fields: NewPurgeJob, units: number) {
	const job = await createPurgeJob(ctx, fields);
	const isDone = await runJobPlan(ctx, job, planOf(job), unitBudget(units));
	if (!isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.continueJob, {
			jobId: job._id,
		});
	}
}

/** Remove what `sources` contributed to one thread's brief (see `purge.ts`). */
export async function purgeSourcesFromThread(
	ctx: MutationCtx,
	ref: ThreadRef,
	sources: readonly InterpretationSource[]
): Promise<void> {
	if (sources.length === 0) return;
	await bumpDeletionEpoch(ctx, ref);
	await startScheduled(ctx, { ref, kind: 'sources', sources: [...sources] }, INLINE_PURGE_UNITS);
}

/** Purge a deleted thread's brief (see `purgeThread.ts`). Call where the thread is deleted. */
export async function purgeThreadBrief(
	ctx: MutationCtx,
	ref: ThreadRef,
	inlineUnits: number = INLINE_PURGE_UNITS
): Promise<void> {
	await bumpDeletionEpoch(ctx, ref);
	await startScheduled(ctx, { ref, kind: 'thread' }, inlineUnits);
}

/**
 * Drive a job keyed `jobKey` within the caller's budget (the erasure
 * walkers): found again in the caller's next transaction, never scheduled.
 * Returns whether it finished.
 */
export async function drivePurgeJob(
	ctx: MutationCtx,
	jobKey: string,
	fields: Omit<NewPurgeJob, 'jobKey'>,
	budget: DrainBudget
): Promise<boolean> {
	let job = await findPurgeJob(ctx, jobKey);
	if (!job) {
		await bumpDeletionEpoch(ctx, fields.ref);
		job = await createPurgeJob(ctx, { ...fields, jobKey });
	}
	return runJobPlan(ctx, job, planOf(job), budget);
}

/**
 * One page of a mailbox's threads for a scope change: each thread with a
 * brief starts a `scope` job (replacing one of an earlier change still
 * running). Stops when the mailbox is gone or its scope no longer matches
 * `mode` (a later change runs its own walk).
 */
export async function invalidateMailboxThreadsPage(
	ctx: MutationCtx,
	args: { mailboxId: Id<'mailboxes'>; mode: InterpretMode; cursor: string | null }
): Promise<{ isDone: boolean; threads: number }> {
	const mailbox = await ctx.db.get(args.mailboxId);
	if (!mailbox || modeOfScope(mailbox) !== args.mode) return { isDone: true, threads: 0 };
	const page = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
		.paginate({ cursor: args.cursor, numItems: THREAD_PAGE });
	for (const thread of page.page) await startThreadScopeChange(ctx, thread, args.mode);
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
			...args,
			cursor: page.continueCursor,
		});
	}
	return { isDone: page.isDone, threads: page.page.length };
}

async function startThreadScopeChange(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	mode: InterpretMode
): Promise<void> {
	const jobKey = `scope:${thread._id}`;
	const earlier = await findPurgeJob(ctx, jobKey);
	if (earlier) await ctx.db.delete(earlier._id);
	if (!(await startScopeChange(ctx, thread._id, mode))) return;
	const job = await createPurgeJob(ctx, {
		ref: { kind: 'mail', id: thread._id },
		kind: 'scope',
		mode,
		jobKey,
	});
	const isDone = await runJobPlan(ctx, job, scopePlan, unitBudget(INLINE_SCOPE_UNITS));
	if (!isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.continueJob, {
			jobId: job._id,
		});
	}
}
