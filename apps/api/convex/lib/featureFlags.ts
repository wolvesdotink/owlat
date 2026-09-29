/**
 * Convex-side feature flag helpers.
 *
 * Public functions in gated modules should call `assertFeatureEnabled(ctx, 'inbox')`
 * at the top. The check reads the `featureFlagSettings` singleton (plan 2.4: a
 * document no counter writes, so gated queries are not re-run by counter traffic)
 * and resolves dependencies via the shared `resolveFlags` helper, throwing a
 * `forbidden` Operation error when off.
 */

import {
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { throwForbidden } from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import { FEATURE_FLAG_REGISTRY } from '../plugins/featureFlagRegistry';
import { readFeatureFlagSettings } from './featureFlagSettings';

/**
 * Read the stored feature flag map from the `featureFlagSettings` singleton
 * (the deprecated `instanceSettings` column before the backfill). An empty
 * object when nothing is stored yet (defaults apply at resolution time via
 * `resolveFlags`).
 */
export async function getStoredFlags(ctx: QueryCtx | MutationCtx): Promise<FeatureFlagState> {
	return (await readFeatureFlagSettings(ctx.db)).featureFlags as FeatureFlagState;
}

/**
 * Returns true if the given flag is enabled. Does not throw.
 */
export async function isFeatureEnabled(
	ctx: QueryCtx | MutationCtx,
	flag: FeatureFlagKey
): Promise<boolean> {
	const stored = await getStoredFlags(ctx);
	return resolveStoredFeatureFlags(stored)[flag] === true;
}

/** Resolve storage through the composition registry, dropping stale plugin keys. */
export function resolveStoredFeatureFlags(
	stored: FeatureFlagState
): Record<FeatureFlagKey, boolean> {
	return resolveFlags(stored, { registry: FEATURE_FLAG_REGISTRY });
}

/**
 * Throws a `forbidden` Operation error if the given flag is disabled.
 * Use at the top of public functions in gated modules.
 *
 * @example
 *   export const list = authedQuery({
 *     handler: async (ctx) => {
 *       await assertFeatureEnabled(ctx, 'inbox');
 *       // ...
 *     }
 *   });
 */
export async function assertFeatureEnabled(
	ctx: QueryCtx | MutationCtx,
	flag: FeatureFlagKey
): Promise<void> {
	const enabled = await isFeatureEnabled(ctx, flag);
	if (!enabled) throwFeatureDisabled(flag);
}

/**
 * The `forbidden` error a single-flag floor throws. Shared with the action-side
 * floors (`assertExternalEnabled`, `assertCampaignsEnabledInAction`), which
 * resolve the flag through the internal mirror query because actions have no
 * `ctx.db`, so every floor reports a disabled flag the same way.
 */
export function throwFeatureDisabled(flag: FeatureFlagKey): never {
	throwForbidden(
		`Feature "${flag}" is disabled on this Owlat instance. An admin can enable it from Settings → Features.`,
		// `features` is the key both helpers carry, so a client can read one
		// field whether the floor was single-flag or any-of; `feature` stays for
		// the callers that already read it.
		{ feature: flag, features: [flag] }
	);
}

/**
 * Throws a `forbidden` Operation error unless **at least one** of the given
 * flags is enabled. The any-of counterpart to `assertFeatureEnabled`, for
 * surfaces a user reaches through more than one independent capability — the
 * Postbox UI, for instance, serves both hosted mailboxes (`postbox`) and
 * connected external ones (`mail.external`), and `mail.external` deliberately
 * does not depend on `postbox` (see the flag's comment in
 * `@owlat/shared/featureFlags`). Asserting either flag alone would lock out
 * half the instances that legitimately have the surface.
 *
 * Reads storage once for the whole set, so an any-of floor costs the same as a
 * single-flag one.
 */
export async function assertAnyFeatureEnabled(
	ctx: QueryCtx | MutationCtx,
	flags: readonly [FeatureFlagKey, ...FeatureFlagKey[]]
): Promise<void> {
	const resolved = resolveStoredFeatureFlags(await getStoredFlags(ctx));
	if (flags.some((flag) => resolved[flag] === true)) return;
	const names = flags.map((flag) => `"${flag}"`).join(' or ');
	throwForbidden(
		`This area needs ${names} enabled on this Owlat instance. An admin can enable it from Settings → Features.`,
		{ features: [...flags] }
	);
}
