/**
 * Read / start / cancel for the resumable per-mailbox walks: the attachment
 * index backfill (`mail/attachmentBackfill.ts`), the body-search backfill
 * (`mail/bodySearchBackfill.ts`) and the retroactive filter run
 * (`mail/filterRun.ts`).
 *
 * Each walk keeps ONE job row per subject (a mailbox, or a filter) carrying the
 * shared `mailboxJobFields` columns, and each follows the same lifecycle:
 *
 *   - start is re-entrant: a job already `running` is left alone rather than
 *     forked, so a double click cannot produce two walks racing over one cursor;
 *   - a restart resets the cursor, the counters and the finish/error columns
 *     on the existing row instead of inserting a second one;
 *   - cancel only moves a `running` job, so it cannot rewrite how a finished
 *     walk ended.
 *
 * What stays in the modules: authorization (mailbox owner, filter lookup),
 * body search's instance-switch refusal, the function builder, and which
 * `runBatch` a start schedules. This file decides nothing about who may call.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `mail/**` modules.
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { mailboxJobFields } from '../lib/validators/mail';

/** The id each job table is keyed by. The table fixes its index (see `readJob`). */
type JobKeys = {
	mailAttachmentBackfillJobs: Id<'mailboxes'>;
	mailBodySearchBackfillJobs: Id<'mailboxes'>;
	mailFilterRunJobs: Id<'mailFilters'>;
};

type MailboxJobTable = keyof JobKeys;

/** Which job row: the table plus the id it is keyed by. */
type MailboxJobLocator<T extends MailboxJobTable> = { table: T; key: JobKeys[T] };

/** A table's own columns: everything except the shared lifecycle columns. */
type MailboxJobOwnFields<T extends MailboxJobTable> = Omit<
	WithoutSystemFields<Doc<T>>,
	keyof typeof mailboxJobFields
>;

type StartJobArgs<T extends MailboxJobTable> = MailboxJobLocator<T> & {
	/** The table's own columns for a new row: key ids, counter, mode. */
	insertFields: MailboxJobOwnFields<T>;
	/** What a restart overwrites on an existing row (counter, mode); key ids stay. */
	resetFields: Partial<MailboxJobOwnFields<T>>;
	/** Kicks off the first batch. Called only when the job was (re)started. */
	schedule: () => Promise<unknown>;
};

/**
 * The same shapes as a union over the three tables. The exported signatures
 * are generic so a call site gets its own table's row and columns checked; the
 * implementations take this union, which narrows on `table`, so no write needs
 * a cast.
 */
type AnyLocator = { [T in MailboxJobTable]: MailboxJobLocator<T> }[MailboxJobTable];
type AnyStartJobArgs = { [T in MailboxJobTable]: StartJobArgs<T> }[MailboxJobTable];
type AnyJob = Doc<MailboxJobTable>;

/** The job row for a mailbox (or filter), or null when the walk never ran there. */
export function readJob<T extends MailboxJobTable>(
	ctx: { db: QueryCtx['db'] },
	locator: MailboxJobLocator<T>
): Promise<Doc<T> | null>;
export function readJob(ctx: { db: QueryCtx['db'] }, locator: AnyLocator): Promise<AnyJob | null> {
	switch (locator.table) {
		case 'mailAttachmentBackfillJobs':
			return ctx.db
				.query('mailAttachmentBackfillJobs')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', locator.key))
				.first();
		case 'mailBodySearchBackfillJobs':
			return ctx.db
				.query('mailBodySearchBackfillJobs')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', locator.key))
				.first();
		case 'mailFilterRunJobs':
			return ctx.db
				.query('mailFilterRunJobs')
				.withIndex('by_filter', (q) => q.eq('filterId', locator.key))
				.first();
	}
}

/**
 * Start (or restart) a walk. Returns `{ started: false }` and changes nothing
 * when the job is already running. Otherwise it resets the existing row, or
 * inserts one, and then calls `schedule` to kick off the first batch.
 */
export function startJob<T extends MailboxJobTable>(
	ctx: { db: MutationCtx['db'] },
	job: StartJobArgs<T>
): Promise<{ started: boolean }>;
export async function startJob(
	ctx: { db: MutationCtx['db'] },
	job: AnyStartJobArgs
): Promise<{ started: boolean }> {
	const existing: AnyJob | null = await readJob(ctx, job);
	if (existing?.status === 'running') return { started: false };

	const now = Date.now();
	const running = {
		status: 'running' as const,
		scannedCount: 0,
		startedAt: now,
		updatedAt: now,
	};
	if (existing) {
		await ctx.db.patch(existing._id, {
			...job.resetFields,
			...running,
			cursor: undefined,
			finishedAt: undefined,
			errorMessage: undefined,
		});
	} else {
		await ctx.db.insert(job.table, { ...job.insertFields, ...running });
	}
	await job.schedule();
	return { started: true };
}

/**
 * Stop a running walk. A job that is not running (absent, finished, failed or
 * already cancelled) is left as it is. Whatever the walk wrote so far stays.
 */
export function cancelJob<T extends MailboxJobTable>(
	ctx: { db: MutationCtx['db'] },
	locator: MailboxJobLocator<T>
): Promise<void>;
export async function cancelJob(
	ctx: { db: MutationCtx['db'] },
	locator: AnyLocator
): Promise<void> {
	const job: AnyJob | null = await readJob(ctx, locator);
	if (!job || job.status !== 'running') return;
	const now = Date.now();
	await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
}
