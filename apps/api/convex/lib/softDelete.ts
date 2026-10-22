/**
 * Recently deleted: the shared vocabulary of the marketing soft-delete
 * (campaigns, automations, email templates).
 *
 * A delete stamps `deletedAt` / `deletedBy` on the row and leaves it, and
 * everything that hangs off it, in place for {@link SOFT_DELETE_RETENTION_MS};
 * the daily purge (`marketing/recentlyDeleted.ts`) removes it for good after
 * that. Until then a deleted row is invisible: every read that serves a user,
 * an API key or the send path treats it as missing, which is what these
 * helpers are for. Writes go through the per-domain `deletion.ts` owners; the
 * purge helpers here (`purgeBudget`, `drainExpiredRows`, `assertRestorable`)
 * keep their purges bounded and a partly purged row out of reach of restore.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { throwInvalidState, throwNotFound } from '../_utils/errors';
import { ErasureBudget } from '../contacts/erasure/budget';

/** How long a deleted item stays restorable before the purge removes it. */
export const SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What a delete or restore call did: `unchanged` when it was already done. */
export type DeletionOutcome = 'changed' | 'unchanged';

/** The audit `userId` of the retention purge. */
export const RETENTION_PURGE_USER = 'system:retention_purge';

/** The tables that soft-delete through this module. */
export type SoftDeletableTable = 'campaigns' | 'automations' | 'emailTemplates';

/** Any row that can carry the soft-delete stamp. */
export interface SoftDeletable {
	deletedAt?: number;
	purgeStartedAt?: number;
}

/** Rows one purge transaction may read and remove, across all three kinds. */
const PURGE_ROWS_PER_TRANSACTION = 400;

/**
 * Bytes one purge transaction may read, across all three kinds. Every row read
 * is also deleted or patched, so the write side stays under the same multiple
 * of this, well inside Convex's per-transaction limits.
 */
const PURGE_BYTES_PER_TRANSACTION = 4 * 1024 * 1024;

/**
 * The allowance one purge transaction shares between the three kinds and what
 * hangs off their rows (a template's version history, an automation's steps).
 * A row whose children outrun it is finished by the next transaction.
 */
export function purgeBudget(): ErasureBudget {
	return new ErasureBudget(PURGE_ROWS_PER_TRANSACTION, PURGE_BYTES_PER_TRANSACTION);
}

/** What one purge pass over a kind did, and whether it must come back. */
export interface PurgeProgress {
	purged: number;
	hasMore: boolean;
}

/**
 * Purge expired rows of one kind, oldest first, until `limit` rows are gone,
 * the budget runs out or none are left. `next` reads the oldest expired row
 * still there; `purgeOne` removes it with what hangs off it, charging the
 * budget, and returns false when it ran out first (the row stays selected, so
 * the next pass resumes it).
 */
export async function drainExpiredRows<T>(
	budget: ErasureBudget,
	limit: number,
	next: () => Promise<T | null>,
	purgeOne: (row: T) => Promise<boolean>
): Promise<PurgeProgress> {
	let purged = 0;
	while (purged < limit && !budget.isExhausted) {
		const row = await next();
		if (row === null) return { purged, hasMore: false };
		if (!(await purgeOne(row))) return { purged, hasMore: true };
		purged += 1;
	}
	if (budget.isExhausted) return { purged, hasMore: true };
	return { purged, hasMore: (await next()) !== null };
}

/**
 * Refuse to restore a row the purge has started removing: some of what hung
 * off it is gone, so what would come back is not what was deleted.
 */
export function assertRestorable(doc: SoftDeletable): void {
	if (doc.purgeStartedAt !== undefined) {
		throwInvalidState('This item is being permanently deleted and can no longer be restored');
	}
}

/** True when the row exists and is not in Recently deleted. */
export function isLive<T extends SoftDeletable>(doc: T | null | undefined): doc is T {
	return doc !== null && doc !== undefined && doc.deletedAt === undefined;
}

/** The instant a row deleted at `deletedAt` is purged. */
export function purgeAt(deletedAt: number): number {
	return deletedAt + SOFT_DELETE_RETENTION_MS;
}

type LiveReader = {
	db: { get<TN extends SoftDeletableTable>(id: Id<TN>): Promise<Doc<TN> | null> };
};

/** The row, or null when it is missing or deleted. */
export async function getLive<T extends SoftDeletableTable>(
	ctx: LiveReader,
	id: Id<T>
): Promise<Doc<T> | null> {
	const doc = await ctx.db.get(id);
	// Every SoftDeletableTable carries `softDeleteFields`; `Doc<T>` over a
	// generic `T` cannot show that.
	return doc !== null && (doc as SoftDeletable).deletedAt === undefined ? doc : null;
}

/**
 * The row, or the same `not_found` error `getOrThrow` raises. A deleted item
 * reads as missing to every write but restore, so a stale tab cannot edit,
 * schedule or publish it.
 */
export async function getLiveOrThrow<T extends SoftDeletableTable>(
	ctx: LiveReader,
	id: Id<T>,
	label: string
): Promise<Doc<T>> {
	const doc = await getLive(ctx, id);
	if (!doc) throwNotFound(label);
	return doc;
}
