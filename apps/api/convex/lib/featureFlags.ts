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
	return resolveFlags(stored)[flag];
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
			{ feature: flag },
		);
	}
}
