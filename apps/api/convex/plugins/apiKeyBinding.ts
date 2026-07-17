/**
 * Plugin-bound API keys (Tier 2) — effective-scope derivation.
 *
 * A key row with `pluginId` set belongs to a connected app / bundled plugin.
 * Its stored `scopes` are only *requests*; the scopes it can actually exercise
 * are re-derived on every request as the intersection of:
 *
 *   stored scopes  ∩  the plugin's declared manifest capabilities
 *                  ∩  the operator's capability grants
 *
 * gated by the plugin's feature flag being enabled. This is the "grants can
 * only restrict the manifest, never widen it" invariant made concrete: the
 * manifest is the ceiling, the operator grant restricts it, and the key can
 * never carry more than the operator granted. Because it is recomputed per
 * request, disabling the plugin, uninstalling it, or revoking a grant fails the
 * key closed immediately — no key mutation required.
 *
 * The scope string doubles as the plugin-capability string for API access
 * (see `auth/apiScopes.ts`): to let a plugin-bound key call the v1 API with
 * scope `contacts:read`, the plugin must declare capability `contacts:read`
 * and the operator must grant it.
 */

import { parsePluginId, type PluginId, type PluginManifest } from '@owlat/plugin-kit';
import { resolveFlags } from '@owlat/shared/featureFlags';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isApiScope, type ApiScope } from '../auth/apiScopes';
import { getBundledPluginManifest } from './authorization';
import { FEATURE_FLAG_REGISTRY } from './featureFlagRegistry';

/**
 * The plugin-side facts an effective-scope decision depends on. `manifest` is
 * `null` when the bound plugin cannot be resolved (uninstalled / removed from
 * the composition) — that alone fails the key closed.
 */
export interface PluginBoundKeyContext {
	readonly manifest: PluginManifest | null;
	readonly flagEnabled: boolean;
	readonly grantedCapabilities: Readonly<Record<string, boolean>> | undefined;
}

/**
 * Pure derivation of a plugin-bound key's effective scopes. Fails closed
 * (returns `[]`) when the plugin is unresolved or its flag is disabled; never
 * returns a scope that is not a known `ApiScope`, not declared in the manifest,
 * or not granted by the operator. De-duplicates while preserving order.
 */
export function resolvePluginBoundScopes(
	storedScopes: readonly string[],
	context: PluginBoundKeyContext
): ApiScope[] {
	if (!context.flagEnabled || context.manifest === null) return [];
	const declared = new Set<string>(context.manifest.capabilities);
	const grants = context.grantedCapabilities;
	const seen = new Set<string>();
	const effective: ApiScope[] = [];
	for (const scope of storedScopes) {
		if (seen.has(scope)) continue;
		if (isApiScope(scope) && declared.has(scope) && grants?.[scope] === true) {
			seen.add(scope);
			effective.push(scope);
		}
	}
	return effective;
}

/**
 * The set of scopes a plugin-bound key is *allowed* to be minted with right
 * now: the manifest-declared capabilities that are also operator-granted (with
 * the flag enabled). This is the create-time ceiling; requested scopes outside
 * it are rejected. Returns only strings that are valid `ApiScope`s.
 */
export function allowedPluginBoundScopes(context: PluginBoundKeyContext): ApiScope[] {
	if (!context.flagEnabled || context.manifest === null) return [];
	const grants = context.grantedCapabilities;
	const seen = new Set<string>();
	const allowed: ApiScope[] = [];
	for (const capability of context.manifest.capabilities) {
		if (seen.has(capability)) continue;
		if (isApiScope(capability) && grants?.[capability] === true) {
			seen.add(capability);
			allowed.push(capability);
		}
	}
	return allowed;
}

/**
 * Load the manifest / flag / grant facts for a bound plugin inside the caller's
 * transaction. Every field is read fresh so revocation is immediate. A plugin
 * id that fails to parse or resolve yields a `null` manifest (fail closed).
 */
export async function loadPluginBoundKeyContext(
	ctx: QueryCtx | MutationCtx,
	pluginIdInput: string
): Promise<PluginBoundKeyContext> {
	let pluginId: PluginId;
	let manifest: PluginManifest | null;
	try {
		pluginId = parsePluginId(pluginIdInput);
		manifest = getBundledPluginManifest(pluginId);
	} catch {
		return { manifest: null, flagEnabled: false, grantedCapabilities: undefined };
	}

	const flagKey = `plugin.${pluginId}` as const;
	const settings = await ctx.db.query('instanceSettings').first();
	const flags = resolveFlags(settings?.featureFlags ?? {}, { registry: FEATURE_FLAG_REGISTRY });
	const flagEnabled = manifest.flag !== undefined && flags[flagKey] === true;
	return {
		manifest,
		flagEnabled,
		grantedCapabilities: settings?.pluginCapabilityGrants?.[flagKey],
	};
}

/**
 * Effective scopes for any key row at enforcement time. Standalone keys (no
 * `pluginId`) return their stored scopes verbatim (legacy rows with absent
 * scopes ⇒ deny-all). Plugin-bound keys re-derive against the live manifest,
 * flag, and grants.
 */
export async function deriveEffectiveScopes(
	ctx: QueryCtx | MutationCtx,
	key: { scopes?: readonly string[]; pluginId?: string }
): Promise<string[]> {
	if (key.pluginId === undefined) return [...(key.scopes ?? [])];
	const context = await loadPluginBoundKeyContext(ctx, key.pluginId);
	return resolvePluginBoundScopes(key.scopes ?? [], context);
}
