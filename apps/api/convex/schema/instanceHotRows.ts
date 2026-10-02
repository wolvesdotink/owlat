import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { inboxStatsValidator, mtaHealthSnapshotValidator } from './instance';

/**
 * The rows split off the `instanceSettings` singleton (plan 2.4).
 *
 * Convex re-runs a query when any document it read changes. Every feature-flag
 * gate (`lib/featureFlags.ts`, reached from `postboxQuery`, `requireMailboxAccess`
 * and most authed functions) used to read `instanceSettings`, and the same row
 * took a write on every contact insert, inbound message, transactional send and
 * MTA health poll. Each of those writes re-ran every gated query in every open
 * tab. The flags now live on their own singleton and each counter family on its
 * own row, so a gate read never shares a document with a frequent writer, and
 * one counter's writes never re-run another counter's readers.
 *
 * Widen, migrate, narrow: the old columns stay on `instanceSettings` (marked
 * deprecated) and readers fall back to them until
 * `migrations/0046_split_hot_rows` has copied them over. Writers write here,
 * seeding a missing row from the old columns first.
 *
 * Spread into `defineSchema()` from schema.ts via `...instanceHotRowTables`.
 */
export const instanceHotRowTables = {
	// Feature flags and plugin capability grants: rarely written, read by every
	// gate. Singleton. Written only through `lib/featureFlagSettings.ts`
	// (by `workspaces/featureFlags.ts`), which also mirrors the values onto the
	// deprecated `instanceSettings` columns so a rollback still reads them.
	featureFlagSettings: defineTable({
		// Feature toggles (see packages/shared/src/featureFlags.ts for the schema).
		// Unset keys fall back to FEATURE_FLAGS[key].default at resolution time.
		// Includes `campaigns.archive`; there is no separate `archiveEnabled` column.
		featureFlags: v.optional(v.record(v.string(), v.boolean())),
		// Explicit operator approvals for capabilities requested by each bundled
		// plugin flag. The host still checks each grant at call time; disabling a
		// plugin clears its record so re-enabling always requires fresh approval.
		pluginCapabilityGrants: v.optional(v.record(v.string(), v.record(v.string(), v.boolean()))),
		updatedAt: v.number(),
	}),

	// Instance counters and telemetry: one row per `key`, each written often and
	// read by a few dashboards. Written only through `lib/instanceCounters.ts`.
	// A row carries only the fields of its key:
	//   - contacts:     contactCount, maintained on contact create/delete and by
	//                   the daily reconcile (`lib/contactCountHelpers.ts`).
	//   - inbox:        inboxStats, inbound messages by processing bucket
	//                   (`inbox/messages.ts` on insert,
	//                   `inbox/processingLifecycle` on transitions), and
	//                   openThreads, conversation threads in 'open'
	//                   (`applyOpenThreadDelta`, called by the Conversation thread
	//                   module and `unifiedMessages.resolveOutboundThread`).
	//                   `inbox/queries.getInboundStats` reads both instead of
	//                   collecting the tables per subscriber.
	//   - sends:        transactionalSendCount, dailySendCount, dailySendCountResetAt
	//                   (transactional dispatch and campaign send pages).
	//   - mtaHealth:    mtaHealth, the latest non-secret MTA /health snapshot,
	//                   synced by a cron (`delivery/mtaHealth.ts`) so reactive
	//                   Delivery surfaces can report infrastructure readiness.
	//   - deliveryTest: deliveryTestLastSucceededAt, the last successful
	//                   Settings → Delivery test send (send-path-verified signal).
	//   - imapLegacy:   legacyImapSeenAt, the last login through an IMAP server
	//                   too old to report its version (v0.6.7 and older;
	//                   `mail/appPasswords.touch`), written at most hourly.
	//                   Read by `mail/imap/serverRegistry` (ADR-0063).
	instanceCounters: defineTable({
		key: v.union(
			v.literal('contacts'),
			v.literal('inbox'),
			v.literal('sends'),
			v.literal('mtaHealth'),
			v.literal('deliveryTest'),
			v.literal('imapLegacy')
		),
		contactCount: v.optional(v.number()),
		inboxStats: v.optional(inboxStatsValidator),
		openThreads: v.optional(v.number()),
		transactionalSendCount: v.optional(v.number()),
		dailySendCount: v.optional(v.number()),
		dailySendCountResetAt: v.optional(v.number()),
		mtaHealth: v.optional(mtaHealthSnapshotValidator),
		deliveryTestLastSucceededAt: v.optional(v.number()),
		legacyImapSeenAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index('by_key', ['key']),
};
