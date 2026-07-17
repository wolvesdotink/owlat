/**
 * Plugin settings (module) — admin surface behind the schema-rendered plugin
 * settings UX. Reads the immutable bundled-plugin manifests plus the singleton
 * `instanceSettings` row and exposes:
 *
 *   - `getPluginSettingsOverview` — admin query. For every bundled plugin:
 *     enablement, capability grants, and the operator-configured values. SECRET
 *     field values are redacted server-side to a presence boolean and NEVER
 *     leave the backend. Also surfaces "orphaned" residual settings left behind
 *     by a plugin that was removed from the build, so an operator can purge them.
 *   - `setPluginSettings` — admin mutation. Validates a partial update against
 *     the plugin's `settingsSchema`, merges it over the stored values (an omitted
 *     secret keeps the stored one), and persists. Returns the redacted view.
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
				storedFor(pluginSettings, flagKey)
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
		const merged: Record<string, JsonPrimitive> = {
			...(currentAll[flagKey] ?? {}),
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
			pluginId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: settingsId,
			detailsBlob: JSON.stringify({
				pluginId,
				changedFields: Object.keys(validation.values).sort(),
			}),
		});

		return redactPluginSettingsValues(schema, merged);
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

		const existing = await readInstanceSettings(ctx);
		const currentAll = (existing?.pluginSettings ?? {}) as StoredPluginSettings;
		if (!existing || !Object.prototype.hasOwnProperty.call(currentAll, flagKey)) {
			// Nothing stored — reset is idempotent, report the schema defaults view.
			const manifest = findBundledManifest(pluginId);
			return redactPluginSettingsValues(manifest?.settingsSchema ?? [], {});
		}

		const nextAll: StoredPluginSettings = { ...currentAll };
		delete nextAll[flagKey];

		await ctx.db.patch(existing._id, { pluginSettings: nextAll, updatedAt: Date.now() });
		await recordAuditLog(ctx, {
			userId: session.userId,
			pluginId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: existing._id,
			detailsBlob: JSON.stringify({ pluginId, reset: true }),
		});

		const manifest = findBundledManifest(pluginId);
		return redactPluginSettingsValues(manifest?.settingsSchema ?? [], {});
	},
});
