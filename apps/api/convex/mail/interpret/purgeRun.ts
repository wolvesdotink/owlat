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
 * Each bumps the epoch in the caller's transaction (in-flight
 * interpretations stop at once), runs a first slice there from the
 * transaction's one shared inline budget (rows and bytes, however many
 * purges it starts), and hands the rest to `purgeJobs.continueJob`, which
 * reschedules itself until every range is exhausted. The erasure walkers drive their jobs themselves
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
/** Bytes the purges of one transaction may read inline, all of them together. */
const INLINE_PURGE_BYTES = 4 * 1024 * 1024;
/** Rows a scheduled continuation spends per transaction. */
export const CONTINUATION_UNITS = 2000;
/** Bytes a scheduled continuation may read per transaction. */
export const CONTINUATION_BYTES = 8 * 1024 * 1024;
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

/**
 * The inline budget of one transaction, shared by every purge it starts (a
 * trash sweep purging messages of many threads spends one budget, not one
 * per thread). Keyed by the transaction's context object.
 */
const inlineBudgets = new WeakMap<object, DrainBudget>();
function inlineBudgetOf(ctx: MutationCtx): DrainBudget {
	let budget = inlineBudgets.get(ctx);
	if (!budget) {
		budget = unitBudget(INLINE_PURGE_UNITS, INLINE_PURGE_BYTES);
		inlineBudgets.set(ctx, budget);
	}
	return budget;
}

/**
 * Start a job and schedule what its first slice leaves. `isInline: false`
 * starts it without a slice (the caller deletes many threads at once).
 */
async function startScheduled(ctx: MutationCtx, fields: NewPurgeJob, isInline: boolean) {
	const job = await createPurgeJob(ctx, fields);
	const budget = isInline ? inlineBudgetOf(ctx) : unitBudget(0, 0);
	const isDone = await runJobPlan(ctx, job, planOf(job), budget);
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
	await startScheduled(ctx, { ref, kind: 'sources', sources: [...sources] }, true);
}

/** Purge a deleted thread's brief (see `purgeThread.ts`). Call where the thread is deleted. */
export async function purgeThreadBrief(
	ctx: MutationCtx,
	ref: ThreadRef,
	opts: { isInline?: boolean } = {}
): Promise<void> {
	await bumpDeletionEpoch(ctx, ref);
	await startScheduled(ctx, { ref, kind: 'thread' }, opts.isInline ?? true);
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
	// No inline slice: a page starts 25 threads, each walk runs on its own.
	await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.continueJob, {
		jobId: job._id,
	});
}
