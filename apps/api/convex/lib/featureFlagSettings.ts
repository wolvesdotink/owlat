/**
 * The one read helper and the one write path for the `featureFlagSettings`
 * singleton (plan 2.4).
 *
 * Every feature gate reads the flag map, so it lives on a document nothing
 * else writes: counters and telemetry moved to `instanceCounters`
 * (`lib/instanceCounters.ts`), and the rest of `instanceSettings` is admin
 * configuration.
 *
 * Widen, migrate, narrow. Until `migrations/0046_split_hot_rows` (or the first
 * flag write) creates the row, reads fall back to the deprecated
 * `instanceSettings.featureFlags` / `pluginCapabilityGrants` columns. Writes
 * seed a missing row from those columns and keep mirroring onto them, so a
 * rollback to a release that reads only `instanceSettings` still sees the
 * flags an admin set after this one shipped. Flag writes are rare, so the
 * mirror costs nothing on the hot path.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { getInstanceSettings, upsertInstanceSettings } from './instanceSettings';

export type StoredFlagMap = NonNullable<Doc<'featureFlagSettings'>['featureFlags']>;
export type StoredCapabilityGrants = NonNullable<
	Doc<'featureFlagSettings'>['pluginCapabilityGrants']
>;

export interface FeatureFlagSettings {
	featureFlags: StoredFlagMap;
	pluginCapabilityGrants: StoredCapabilityGrants;
}

async function getRow(db: DatabaseReader): Promise<Doc<'featureFlagSettings'> | null> {
	return await db.query('featureFlagSettings').first(); // bounded: singleton row
}

/** The deprecated `instanceSettings` flag columns a new singleton starts from. */
function legacyFlagColumns(legacy: Doc<'instanceSettings'> | null): Partial<FeatureFlagSettings> {
	return {
		...(legacy?.featureFlags ? { featureFlags: legacy.featureFlags } : {}),
		...(legacy?.pluginCapabilityGrants
			? { pluginCapabilityGrants: legacy.pluginCapabilityGrants }
			: {}),
	};
}

/**
 * The stored flag map and capability grants. Reads only the dedicated
 * singleton once it exists, so a gated query never subscribes to
 * `instanceSettings`; before that, the deprecated columns.
 */
export async function readFeatureFlagSettings(db: DatabaseReader): Promise<FeatureFlagSettings> {
	const row = await getRow(db);
	const source = row ?? (await getInstanceSettings(db));
	return {
		featureFlags: source?.featureFlags ?? {},
		pluginCapabilityGrants: source?.pluginCapabilityGrants ?? {},
	};
}

/**
 * Write `patch` onto the flag singleton (creating it from the deprecated
 * columns when absent) and mirror it onto `instanceSettings`. Returns the
 * `instanceSettings` id, which audit entries use as the settings resource id.
 */
export async function writeFeatureFlagSettings(
	ctx: MutationCtx,
	patch: Partial<FeatureFlagSettings>
): Promise<Id<'instanceSettings'>> {
	const now = Date.now();
	const row = await getRow(ctx.db);
	if (row) {
		await ctx.db.patch(row._id, { ...patch, updatedAt: now });
	} else {
		await ctx.db.insert('featureFlagSettings', {
			...legacyFlagColumns(await getInstanceSettings(ctx.db)),
			...patch,
			updatedAt: now,
		});
	}
	// Rollback mirror (remove with the narrowing step).
	return await upsertInstanceSettings(ctx, patch, { now });
}

/**
 * Create the singleton from the deprecated columns when it does not exist yet.
 * Idempotent; used by the backfill migration. Returns whether it created one.
 */
export async function ensureFeatureFlagSettings(ctx: MutationCtx): Promise<boolean> {
	if (await getRow(ctx.db)) return false;
	await ctx.db.insert('featureFlagSettings', {
		...legacyFlagColumns(await getInstanceSettings(ctx.db)),
		updatedAt: Date.now(),
	});
	return true;
}
