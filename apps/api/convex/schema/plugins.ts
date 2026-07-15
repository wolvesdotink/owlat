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

	// AGGREGATED — fixed-point micro-USD reservations are serialized through
	// this UTC-day row before a plugin LLM request reaches the provider.
	pluginLlmDailyUsage: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		utcDay: v.string(),
		// Budget headroom currently consumed: pending maximums, failed-call
		// maximums, and settled successful charges.
		chargedMicrousd: v.number(),
		actualMicrousd: v.number(),
		admittedCallCount: v.number(),
		updatedAt: v.number(),
	}).index('by_organization_id_and_plugin_id_and_utc_day', [
		'organizationId',
		'pluginId',
		'utcDay',
	]),

	// One host-generated idempotency record per dispatch. Pending/failed rows
	// remain charged; only a known successful completion can release unused
	// reservation headroom safely.
	pluginLlmReservations: defineTable({
		organizationId: v.string(),
		pluginId: v.string(),
		utcDay: v.string(),
		reservationId: v.string(),
		actorUserId: v.string(),
		reservedMicrousd: v.number(),
		tier: v.union(v.literal('fast'), v.literal('capable')),
		chargedMicrousd: v.optional(v.number()),
		actualMicrousd: v.optional(v.number()),
		status: v.union(v.literal('pending'), v.literal('completed'), v.literal('failed')),
		createdAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index('by_reservation_id', ['reservationId'])
		.index('by_organization_id_and_plugin_id_and_utc_day', [
			'organizationId',
			'pluginId',
			'utcDay',
		]),
};
