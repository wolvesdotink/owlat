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
		.index('by_expiry', ['expiresAt']),
};
