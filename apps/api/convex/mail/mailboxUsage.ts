/**
 * Mailbox storage accounting on the 1:1 `mailboxUsage` row (plan 2.4).
 *
 * Every delivery, sent copy, IMAP APPEND/COPY/EXPUNGE and purge used to patch
 * `mailboxes.usedBytes` / `usageRevision` / `updatedAt`. `requireMailboxAccess`
 * reads the mailbox document, so each of those writes re-ran every Postbox
 * query for the mailbox in every tab, including thread views of unrelated
 * threads. The counters now live on their own row and the mailbox document
 * stays unchanged by mail traffic.
 *
 * Widen, migrate, narrow. Until the row exists (created by the first write or
 * by `migrations/0046_split_hot_rows`), reads fall back to the deprecated
 * columns on the mailbox, and the first write seeds the row from them. The
 * deprecated columns are not written again once the row exists.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

export interface MailboxUsage {
	usedBytes: number;
	usageRevision: number;
}

type MailboxUsageSource = Pick<Doc<'mailboxes'>, '_id' | 'usedBytes' | 'usageRevision'>;

async function getRow(
	db: DatabaseReader,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailboxUsage'> | null> {
	return await db
		.query('mailboxUsage')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.unique(); // bounded: 1:1 with the mailbox
}

function legacyUsage(mailbox: MailboxUsageSource): MailboxUsage {
	return { usedBytes: mailbox.usedBytes, usageRevision: mailbox.usageRevision ?? 0 };
}

/** The mailbox's live byte count and CAS revision. */
export async function readMailboxUsage(
	db: DatabaseReader,
	mailbox: MailboxUsageSource
): Promise<MailboxUsage> {
	const row = await getRow(db, mailbox._id);
	return row
		? { usedBytes: row.usedBytes, usageRevision: row.usageRevision }
		: legacyUsage(mailbox);
}

/** `mailbox` with its live `usedBytes` / `usageRevision`, for callers that hand the row on. */
export async function withMailboxUsage<T extends MailboxUsageSource>(
	db: DatabaseReader,
	mailbox: T
): Promise<T> {
	return { ...mailbox, ...(await readMailboxUsage(db, mailbox)) };
}

/**
 * Write the usage row: `update` maps the current usage to the next byte count.
 * The revision always increments, so a concurrent paginated recount (0042)
 * sees the change. Never patches the mailbox document.
 */
async function writeMailboxUsage(
	ctx: MutationCtx,
	mailbox: MailboxUsageSource,
	update: (current: MailboxUsage) => number,
	now: number
): Promise<MailboxUsage> {
	const row = await getRow(ctx.db, mailbox._id);
	const current = row
		? { usedBytes: row.usedBytes, usageRevision: row.usageRevision }
		: legacyUsage(mailbox);
	const next = { usedBytes: update(current), usageRevision: current.usageRevision + 1 };
	if (row) await ctx.db.patch(row._id, { ...next, updatedAt: now });
	else await ctx.db.insert('mailboxUsage', { mailboxId: mailbox._id, ...next, updatedAt: now });
	return next;
}

/**
 * Add `bytesDelta` (negative to release) to the mailbox's byte count, clamped
 * at zero. A zero delta only bumps the revision.
 */
export async function applyMailboxUsageDelta(
	ctx: MutationCtx,
	mailbox: MailboxUsageSource,
	bytesDelta: number,
	now: number = Date.now()
): Promise<MailboxUsage> {
	return await writeMailboxUsage(
		ctx,
		mailbox,
		(current) => Math.max(0, current.usedBytes + bytesDelta),
		now
	);
}

/**
 * Publish a recounted byte total, but only if nothing changed the usage since
 * the recount read `expectedRevision`. Returns `false` when it lost the race.
 */
export async function setMailboxUsageIfUnchanged(
	ctx: MutationCtx,
	mailbox: MailboxUsageSource,
	usedBytes: number,
	expectedRevision: number
): Promise<boolean> {
	const current = await readMailboxUsage(ctx.db, mailbox);
	if (current.usageRevision !== expectedRevision) return false;
	await writeMailboxUsage(ctx, mailbox, () => usedBytes, Date.now());
	return true;
}

/**
 * Create the usage row from the deprecated mailbox columns when it does not
 * exist yet. Idempotent; used by the backfill migration.
 */
export async function ensureMailboxUsage(
	ctx: MutationCtx,
	mailbox: MailboxUsageSource
): Promise<boolean> {
	if (await getRow(ctx.db, mailbox._id)) return false;
	await ctx.db.insert('mailboxUsage', {
		mailboxId: mailbox._id,
		...legacyUsage(mailbox),
		updatedAt: Date.now(),
	});
	return true;
}

/** Drop the usage row with its mailbox (hard-delete paths). */
export async function deleteMailboxUsage(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	const row = await getRow(ctx.db, mailboxId);
	if (row) await ctx.db.delete(row._id);
}
