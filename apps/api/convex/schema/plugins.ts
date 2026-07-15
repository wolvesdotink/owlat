import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Host-mediated plugin data; Tier-1 component tables remain component-local. */
export const pluginTables = {
	pluginStorageEntries: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		key: v.string(),
		valueJson: v.string(),
		valueJsonVersion: v.optional(v.number()),
		storedBytes: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_organization_id_and_plugin_id_and_key', ['organizationId', 'pluginId', 'key'])
		.index('by_organization_id_and_plugin_id', ['organizationId', 'pluginId']),

	// AGGREGATED — exact quota counters maintained transactionally by the
	// plugin-storage service on every entry insert, overwrite, and delete.
	pluginStorageUsage: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		entryCount: v.number(),
		totalStoredBytes: v.number(),
		updatedAt: v.number(),
	}).index('by_organization_id_and_plugin_id', ['organizationId', 'pluginId']),
};
