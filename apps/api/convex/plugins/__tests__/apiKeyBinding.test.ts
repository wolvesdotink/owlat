import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plugin-bound API keys (PP-21, Tier 2). These tests pin the least-privilege
 * and immediate-revocation contract of the effective-scope derivation:
 *
 *   effective = stored scopes ∩ manifest capabilities ∩ operator grants,
 *               gated by the plugin flag being enabled.
 *
 * The manifest is the ceiling; grants can only restrict it, never widen it; and
 * the derivation is recomputed every request, so disabling the plugin,
 * uninstalling it, or revoking a grant fails the key closed on the spot.
 *
 * A mock composition injects one bundled plugin so the DB-backed
 * `loadPluginBoundKeyContext` has a resolvable manifest and feature flag; the
 * pure `resolvePluginBoundScopes` / `allowedPluginBoundScopes` cases below need
 * no DB and drive every branch directly with synthetic contexts.
 */
vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/connector',
			manifest: Object.freeze({
				id: 'acme-connector',
				version: '1.0.0',
				// Declares three API-scope capabilities plus one non-scope capability
				// (`agent:step`) that must never leak into the scope surface.
				capabilities: Object.freeze(['contacts:read', 'contacts:write', 'mail:read', 'agent:step']),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

import schema from '../../schema';
import {
	allowedPluginBoundScopes,
	deriveEffectiveScopes,
	loadPluginBoundKeyContext,
	resolvePluginBoundScopes,
	type PluginBoundKeyContext,
} from '../apiKeyBinding';

const modules = import.meta.glob('../../**/*.*s');

function ctx(overrides: Partial<PluginBoundKeyContext> = {}): PluginBoundKeyContext {
	return {
		manifest: {
			id: 'acme-connector',
			version: '1.0.0',
			capabilities: ['contacts:read', 'contacts:write', 'mail:read', 'agent:step'],
			flag: { default: false },
		} as unknown as PluginBoundKeyContext['manifest'],
		flagEnabled: true,
		grantedCapabilities: { 'contacts:read': true, 'contacts:write': true, 'mail:read': true },
		...overrides,
	};
}

describe('resolvePluginBoundScopes — least privilege', () => {
	it('returns the intersection of stored, declared, and granted scopes', () => {
		expect(resolvePluginBoundScopes(['contacts:read', 'mail:read'], ctx())).toEqual([
			'contacts:read',
			'mail:read',
		]);
	});

	it('restricts to the operator grant even when the manifest declares more', () => {
		// Manifest declares contacts:write; operator granted only contacts:read.
		const restricted = ctx({ grantedCapabilities: { 'contacts:read': true } });
		expect(resolvePluginBoundScopes(['contacts:read', 'contacts:write'], restricted)).toEqual([
			'contacts:read',
		]);
	});

	it('drops a stored scope the manifest never declared (manifest is the ceiling)', () => {
		// events:write is a real ApiScope but not in this plugin's manifest.
		expect(resolvePluginBoundScopes(['contacts:read', 'events:write'], ctx())).toEqual([
			'contacts:read',
		]);
	});

	it('drops a stored scope that is not a known ApiScope', () => {
		expect(resolvePluginBoundScopes(['contacts:read', 'agent:step'], ctx())).toEqual([
			'contacts:read',
		]);
	});

	it('fails closed to no scopes when the plugin flag is disabled', () => {
		expect(resolvePluginBoundScopes(['contacts:read'], ctx({ flagEnabled: false }))).toEqual([]);
	});

	it('fails closed to no scopes when the plugin cannot be resolved (uninstalled)', () => {
		expect(resolvePluginBoundScopes(['contacts:read'], ctx({ manifest: null }))).toEqual([]);
	});

	it('fails closed when no grants exist at all', () => {
		expect(
			resolvePluginBoundScopes(['contacts:read'], ctx({ grantedCapabilities: undefined }))
		).toEqual([]);
	});

	it('treats an explicit false grant as ungranted', () => {
		expect(
			resolvePluginBoundScopes(
				['contacts:read'],
				ctx({ grantedCapabilities: { 'contacts:read': false } })
			)
		).toEqual([]);
	});

	it('de-duplicates repeated stored scopes while preserving order', () => {
		expect(resolvePluginBoundScopes(['mail:read', 'contacts:read', 'mail:read'], ctx())).toEqual([
			'mail:read',
			'contacts:read',
		]);
	});
});

describe('allowedPluginBoundScopes — creation ceiling', () => {
	it('is the declared-and-granted API scopes (excludes non-scope capabilities)', () => {
		expect(allowedPluginBoundScopes(ctx())).toEqual([
			'contacts:read',
			'contacts:write',
			'mail:read',
		]);
	});

	it('shrinks to only the granted subset', () => {
		expect(allowedPluginBoundScopes(ctx({ grantedCapabilities: { 'mail:read': true } }))).toEqual([
			'mail:read',
		]);
	});

	it('is empty when the flag is disabled or the plugin is unresolved', () => {
		expect(allowedPluginBoundScopes(ctx({ flagEnabled: false }))).toEqual([]);
		expect(allowedPluginBoundScopes(ctx({ manifest: null }))).toEqual([]);
	});
});

describe('loadPluginBoundKeyContext / deriveEffectiveScopes — DB-backed, immediate revocation', () => {
	async function seedSettings(
		featureFlags: Record<string, boolean>,
		grants: Record<string, Record<string, boolean>>
	) {
		const t = convexTest(schema, modules);
		await t.run(async (dbCtx) => {
			await dbCtx.db.insert('instanceSettings', {
				featureFlags,
				pluginCapabilityGrants: grants,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		return t;
	}

	it('resolves manifest, flag, and grants for an installed, enabled, granted plugin', async () => {
		const t = await seedSettings(
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		const result = await t.run(async (dbCtx) => {
			const context = await loadPluginBoundKeyContext(dbCtx, 'acme-connector');
			return {
				hasManifest: context.manifest !== null,
				flagEnabled: context.flagEnabled,
				scopes: resolvePluginBoundScopes(['contacts:read', 'contacts:write'], context),
			};
		});
		expect(result.hasManifest).toBe(true);
		expect(result.flagEnabled).toBe(true);
		// contacts:write declared but not granted → restricted away.
		expect(result.scopes).toEqual(['contacts:read']);
	});

	it('fails a bound key closed the instant its flag is disabled', async () => {
		const t = await seedSettings(
			{ 'plugin.acme-connector': false },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		const scopes = await t.run(async (dbCtx) =>
			deriveEffectiveScopes(dbCtx, { scopes: ['contacts:read'], pluginId: 'acme-connector' })
		);
		expect(scopes).toEqual([]);
	});

	it('fails a bound key closed the instant its grant is revoked', async () => {
		const t = await seedSettings(
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': {} }
		);
		const scopes = await t.run(async (dbCtx) =>
			deriveEffectiveScopes(dbCtx, { scopes: ['contacts:read'], pluginId: 'acme-connector' })
		);
		expect(scopes).toEqual([]);
	});

	it('fails closed for a key bound to an uninstalled plugin', async () => {
		const t = await seedSettings({}, {});
		const scopes = await t.run(async (dbCtx) =>
			deriveEffectiveScopes(dbCtx, { scopes: ['contacts:read'], pluginId: 'ghost-plugin' })
		);
		expect(scopes).toEqual([]);
	});

	it('returns stored scopes verbatim for a standalone (unbound) key', async () => {
		const t = await seedSettings({}, {});
		const scopes = await t.run(async (dbCtx) =>
			deriveEffectiveScopes(dbCtx, { scopes: ['contacts:read', 'events:write'] })
		);
		expect(scopes).toEqual(['contacts:read', 'events:write']);
	});

	it('denies a legacy standalone key with an absent scopes field', async () => {
		const t = await seedSettings({}, {});
		const scopes = await t.run(async (dbCtx) => deriveEffectiveScopes(dbCtx, {}));
		expect(scopes).toEqual([]);
	});
});
