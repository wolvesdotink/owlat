/**
 * The one read helper and the one insert site for the singleton
 * `instanceSettings` row.
 *
 * Many modules write their own columns onto this row, and any of them can be
 * the first writer on a fresh deployment. Each used to hand-roll "patch if
 * present, else insert", so the row's creation depended on whichever writer
 * ran first. Every writer now goes through
 * `upsertInstanceSettings`; `scripts/check-convex-patterns.sh` fails a raw
 * `insert('instanceSettings'` anywhere else.
 *
 * Column owners (see the `workspaces/settings.ts` header and ADR-0026):
 *   - Organization settings (`workspaces/settings.ts`): `emailTheme`,
 *     `timezone`, `defaultFromName`, `defaultFromEmail`, `isMigrationMode`,
 *     `isInboundTlsRequired`, `updatedAt`, and the admin-seed latch
 *     `adminSeedCompletedAt`.
 *   - Feature flags (`workspaces/featureFlags.ts`): the deprecated
 *     `featureFlags` / `pluginCapabilityGrants` rollback mirror; the live copy
 *     is the `featureFlagSettings` singleton (`lib/featureFlagSettings.ts`).
 *   - Abuse status (`workspaces/abuseStatus.ts`): the abuse-status columns.
 *   - Workspace branding (`workspaces/branding.ts`): the logo columns.
 *
 * Counters and telemetry (contact count, inbox and send counters, MTA health,
 * delivery-test stamp) no longer belong here: they live on `instanceCounters`
 * rows (`lib/instanceCounters.ts`, plan 2.4) so this row stays quiet.
 *
 * The seed-owned columns (`timezone`, `defaultFromName`, `isMigrationMode`,
 * `adminSeedCompletedAt`) are never written by an insert here unless the caller
 * passes them, so a row created by a cron or a counter bump still reads as
 * "not seeded" and `/seed/admin` fills them in later.
 *
 * Leaf module: it imports only types, so `lib/` helpers and domain modules can
 * both depend on it without inverting the layering.
 */

import type { WithoutSystemFields } from 'convex/server';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

export type InstanceSettingsFields = Partial<WithoutSystemFields<Doc<'instanceSettings'>>>;

/** Read the singleton `instanceSettings` row, or `null` before anything created it. */
export async function getInstanceSettings(
	db: DatabaseReader
): Promise<Doc<'instanceSettings'> | null> {
	return await db.query('instanceSettings').first(); // bounded: singleton row
}

/**
 * Write `patch` onto the singleton, creating it when none exists yet.
 *
 * On an existing row this patches `{ ...patch, updatedAt: now }`. With no row it
 * inserts `{ ...onCreate, ...patch, createdAt: now, updatedAt: now }`. `onCreate`
 * holds columns that should only be written when this call creates the row.
 */
export async function upsertInstanceSettings(
	ctx: MutationCtx,
	patch: InstanceSettingsFields,
	opts: { now?: number; onCreate?: InstanceSettingsFields } = {}
): Promise<Id<'instanceSettings'>> {
	const now = opts.now ?? Date.now();
	const existing = await getInstanceSettings(ctx.db);
	if (existing) {
		await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
		return existing._id;
	}
	return await ctx.db.insert('instanceSettings', {
		...opts.onCreate,
		...patch,
		createdAt: now,
		updatedAt: now,
	});
}
