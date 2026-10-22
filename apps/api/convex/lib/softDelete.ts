/**
 * Recently deleted: the shared vocabulary of the marketing soft-delete
 * (campaigns, automations, email templates).
 *
 * A delete stamps `deletedAt` / `deletedBy` on the row and leaves it, and
 * everything that hangs off it, in place for {@link SOFT_DELETE_RETENTION_MS};
 * the daily purge (`marketing/recentlyDeleted.ts`) removes it for good after
 * that. Until then a deleted row is invisible: every read that serves a user,
 * an API key or the send path treats it as missing, which is what these
 * helpers are for. Writes go through the per-domain `deletion.ts` owners.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { throwNotFound } from '../_utils/errors';

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
