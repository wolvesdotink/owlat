/**
 * Plugin settings (module) — admin surface behind the schema-rendered plugin
 * settings UX. Reads the immutable bundled-plugin manifests plus the singleton
 * `instanceSettings` row and exposes:
 *
 *   - `getPluginSettingsOverview` — admin query. For every bundled plugin:
 *     enablement, capability grants, and the operator-configured values. A
 *     SECRET field holds no stored value at all — it names a `PLUGIN_`-prefixed
 *     deployment environment variable, and the overview reports only whether
 *     that variable is present, so credential plaintext is never persisted by
 *     Owlat nor sent to the browser. Also surfaces "orphaned" residual settings left behind
 *     by a plugin that was removed from the build, so an operator can purge them.
 *   - `setPluginSettings` — admin mutation. Validates a partial update against
 *     the plugin's `settingsSchema`, merges it over the stored values, and
 *     persists. A value for a `secret` field is rejected outright. Returns the
 *     projected view.
 *   - `resetPluginSettings` — admin mutation. Clears all stored settings for a
 *     plugin id (works for removed plugins too, to purge orphaned config).
 *
 * Feature-flag state and capability grants stay owned by the Feature flags
 * (module); this module only reads them and owns the `pluginSettings` column.
 */

import { v } from 'convex/values';
import {
	parsePluginId,
	redactPluginSettingsValues,
	validatePluginSettingsInput,
	type JsonPrimitive,
	type PluginId,
	type PluginManifest,
} from '@owlat/plugin-kit';
import { resolveFlags } from '@owlat/shared/featureFlags';
import type { QueryCtx } from '../_generated/server';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { requireAdminContext } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { throwInvalidInput } from '../_utils/errors';
import { jsonPrimitiveRecord } from '../lib/convexValidators';
import { isEnvPresent } from '../lib/env';
import { FEATURE_FLAG_REGISTRY } from './featureFlagRegistry';
import { bundledPluginComposition } from './plugins.generated';

// Mirrors the `pluginSettings` column validator (jsonPrimitiveRecord): a flat
// map of primitive field values per plugin flag key.
type StoredPluginSettings = Record<string, Record<string, JsonPrimitive>>;

function pluginFlagKey(pluginId: PluginId): `plugin.${string}` {
	return `plugin.${pluginId}`;
}

function parseBundledPluginId(input: unknown): PluginId {
	try {
		return parsePluginId(input);
	} catch {
		throwInvalidInput('Invalid plugin id');
	}
}

function findBundledManifest(pluginId: PluginId): PluginManifest | undefined {
	return bundledPluginComposition.find((plugin) => plugin.manifest.id === pluginId)?.manifest;
}

async function readInstanceSettings(ctx: QueryCtx) {
	// Org-singleton row ⇒ `first()` is bounded (≤1 row).
	return await ctx.db.query('instanceSettings').first();
}

function storedFor(
	settings: StoredPluginSettings | undefined,
	flagKey: string
): Readonly<Record<string, JsonPrimitive>> {
	return settings?.[flagKey] ?? {};
}

export const getPluginSettingsOverview = adminQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await readInstanceSettings(ctx);
		const resolved = resolveFlags(settings?.featureFlags ?? {}, {
			registry: FEATURE_FLAG_REGISTRY,
		});
		const grants = settings?.pluginCapabilityGrants ?? {};
		const pluginSettings = (settings?.pluginSettings ?? {}) as StoredPluginSettings;

		const installedFlagKeys = new Set<string>();
		const plugins = bundledPluginComposition.map(({ packageName, manifest }) => {
			const flagKey = pluginFlagKey(manifest.id);
			installedFlagKeys.add(flagKey);
			const grantMap = grants[flagKey] ?? {};
			const { values, secretsSet } = redactPluginSettingsValues(
				manifest.settingsSchema ?? [],
				storedFor(pluginSettings, flagKey),
				isEnvPresent
			);
			return {
				pluginId: manifest.id,
				packageName,
				version: manifest.version,
				flagKey,
				enabled: resolved[flagKey] === true,
				hasSettings: (manifest.settingsSchema?.length ?? 0) > 0,
				capabilities: manifest.capabilities.map((capability) => ({
					capability,
					granted: grantMap[capability] === true,
				})),
				values,
				secretsSet,
			};
		});

		// Residual settings for plugins removed from the build: surfaced so an
		// operator can purge them. No manifest is available, so schema/capabilities
		// are unknown — the UI renders a purge-only "no longer installed" state.
		const orphaned = Object.keys(pluginSettings)
			.filter((flagKey) => !installedFlagKeys.has(flagKey))
			.sort()
			.map((flagKey) => ({ flagKey, pluginId: flagKey.replace(/^plugin\./, '') }));

		return { plugins, orphaned };
	},
});

export const setPluginSettings = authedMutation({
	args: {
		pluginId: v.string(),
		values: jsonPrimitiveRecord,
	},
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);
		const pluginId = parseBundledPluginId(args.pluginId);
		const manifest = findBundledManifest(pluginId);
		if (!manifest) throwInvalidInput('Plugin is not installed');
		const schema = manifest.settingsSchema ?? [];
		if (schema.length === 0) throwInvalidInput('Plugin has no configurable settings');

		const validation = validatePluginSettingsInput(schema, args.values);
		if (!validation.ok) {
			const detail = validation.issues.map((issue) => `${issue.key}: ${issue.message}`).join('; ');
			throwInvalidInput(`Invalid plugin settings: ${detail}`);
		}

		const flagKey = pluginFlagKey(pluginId);
		const existing = await readInstanceSettings(ctx);
		const currentAll = (existing?.pluginSettings ?? {}) as StoredPluginSettings;
		// Carry over only stored keys the CURRENT schema still declares, and never a
		// key that is now a secret. A field removed from the schema in a plugin
		// upgrade would otherwise persist forever: projection iterates the schema,
		// so a dropped key is invisible to the overview and purgeable only by a full
		// reset. Dropping it on the next save also sweeps any plaintext left by a
		// deployment that predates env-supplied secrets.
		const schemaKeys = new Set(
			schema.filter((field) => field.kind !== 'secret').map((field) => field.key)
		);
		const currentForPlugin = currentAll[flagKey] ?? {};
		const carriedOver: Record<string, JsonPrimitive> = {};
		for (const [key, value] of Object.entries(currentForPlugin)) {
			if (schemaKeys.has(key)) carriedOver[key] = value;
		}
		const merged: Record<string, JsonPrimitive> = {
			...carriedOver,
			...validation.values,
		};
		const nextAll: StoredPluginSettings = { ...currentAll, [flagKey]: merged };

		const now = Date.now();
		let settingsId;
		if (existing) {
			await ctx.db.patch(existing._id, { pluginSettings: nextAll, updatedAt: now });
			settingsId = existing._id;
		} else {
			settingsId = await ctx.db.insert('instanceSettings', {
				pluginSettings: nextAll,
				createdAt: now,
				updatedAt: now,
			});
		}

		// Audit records only which fields changed — never their values, so a secret
		// can never leak into the audit trail.
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			pluginId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: settingsId,
			detailsBlob: JSON.stringify({
				pluginId,
				changedFields: Object.keys(validation.values).sort(),
			}),
		});

		return redactPluginSettingsValues(schema, merged, isEnvPresent);
	},
});

export const resetPluginSettings = authedMutation({
	args: {
		pluginId: v.string(),
	},
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);
		const pluginId = parseBundledPluginId(args.pluginId);
		const flagKey = pluginFlagKey(pluginId);
		const manifest = findBundledManifest(pluginId);

		const existing = await readInstanceSettings(ctx);
		const currentAll = (existing?.pluginSettings ?? {}) as StoredPluginSettings;
		// Only delete + audit when something is actually stored; a reset with
		// nothing stored is idempotent. Either way the return is the same schema
		// defaults view (an orphaned plugin has no manifest ⇒ empty schema).
		if (existing && Object.prototype.hasOwnProperty.call(currentAll, flagKey)) {
			const nextAll: StoredPluginSettings = { ...currentAll };
			delete nextAll[flagKey];
			await ctx.db.patch(existing._id, { pluginSettings: nextAll, updatedAt: Date.now() });
			await recordAuditLog(ctx, {
				userId: session.userId,
				organizationId: session.activeOrganizationId,
				pluginId,
				action: 'settings.updated',
				resource: 'settings',
				resourceId: existing._id,
				detailsBlob: JSON.stringify({ pluginId, reset: true }),
			});
		}

		return redactPluginSettingsValues(manifest?.settingsSchema ?? [], {}, isEnvPresent);
	},
});
