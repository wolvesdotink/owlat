import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Upload provenance is server-written; a storage id alone conveys no ownership. */
export const storageTables = {
	storageUploads: defineTable({
		token: v.optional(v.string()),
		userId: v.string(),
		organizationId: v.string(),
		expiresAt: v.optional(v.number()),
		status: v.union(
			v.literal('pending'),
			v.literal('uploading'),
			v.literal('uploaded'),
			v.literal('bound')
		),
		storageId: v.optional(v.id('_storage')),
		resourceKey: v.optional(v.string()),
	})
		.index('by_token', ['token'])
		.index('by_storage', ['storageId'])
		.index('by_expiry', ['expiresAt'])
		// Blobs bound to a resource that is about to go (a mail thread's Reply
		// Queue answer uploads), found by key when the resource is deleted.
		.index('by_resource', ['resourceKey']),

	// Attachment bytes the transactional API stored before its intake decided.
	// A row is deletion authority for one blob until the dispatch mutation claims
	// it (deleting the row in the transaction that inserts the Send, which owns
	// the blob from then on). Rejections release it; an interrupted request leaves
	// it to the expiry sweep (`transactional/pendingUploads.ts`, ADR-0021).
	transactionalPendingUploads: defineTable({
		storageId: v.id('_storage'),
		expiresAt: v.number(),
		// Failed blob deletions so far. A row only loses its blob once the
		// deletion is confirmed, so a failure keeps it here, unclaimable, and
		// pushes `expiresAt` out for the sweep to retry.
		deleteAttempts: v.optional(v.number()),
	})
		.index('by_storage', ['storageId'])
		.index('by_expiry', ['expiresAt']),
};
