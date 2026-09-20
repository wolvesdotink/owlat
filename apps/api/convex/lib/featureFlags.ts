/**
 * Convex-side feature flag helpers.
 *
 * Public functions in gated modules should call `assertFeatureEnabled(ctx, 'inbox')`
 * at the top. The check reads `instanceSettings.featureFlags` and resolves dependencies
 * via the shared `resolveFlags` helper, throwing a `forbidden` Operation error when off.
 */

import {
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { throwForbidden } from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import { FEATURE_FLAG_REGISTRY } from '../plugins/featureFlagRegistry';

/**
 * Read the stored feature flag map from the singleton instanceSettings row.
 * Falls back to an empty object if no settings exist yet (defaults apply at
 * resolution time via `resolveFlags`).
 */
export async function getStoredFlags(ctx: QueryCtx | MutationCtx): Promise<FeatureFlagState> {
	const settings = await ctx.db.query('instanceSettings').first();
	return (settings?.featureFlags ?? {}) as FeatureFlagState;
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
	if (!enabled) {
		throwForbidden(
			`Feature "${flag}" is disabled on this Owlat instance. An admin can enable it from Settings → Features.`,
			// `features` is the key both helpers carry, so a client can read one
			// field whether the floor was single-flag or any-of; `feature` stays for
			// the callers that already read it.
			{ feature: flag, features: [flag] }
		);
	}
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
