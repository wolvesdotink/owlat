import { describe, expect, it, vi } from 'vitest';

/**
 * Conformance: composing the built-in import providers with the bundled plugin
 * catalog must preserve the built-in kinds and their labels, keep the walker's
 * per-kind adapter dispatch (`providerFor` / `isIntegrationProviderKind`)
 * unchanged, and add plugin providers only as additive, namespaced entries that
 * carry plugin ownership.
 */

vi.mock('../../../plugins/importProviderCatalog.generated', () => ({
	BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.crm-pack.hubspot',
			pluginId: 'crm-pack',
			label: 'HubSpot',
			attestSource: 'hubspot',
			requiredEnvVars: Object.freeze(['HUBSPOT_KEY']),
			signature: Object.freeze({
				header: 'x-hubspot-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'PLUGIN_HUBSPOT_WEBHOOK_SECRET',
			}),
			requiredCapability: 'imports:provide',
		}),
	]),
}));

import {
	importProviderCatalogEntry,
	IMPORT_PROVIDER_KINDS,
	isImportProviderKind,
	isPluginImportProviderKind,
} from '../catalog';
import { isIntegrationProviderKind, providerFor } from '../index';

describe('composed import provider catalog conformance', () => {
	it('retains the built-in providers and their core adapter dispatch', () => {
		expect(isImportProviderKind('mailchimp')).toBe(true);
		expect(isImportProviderKind('stripe')).toBe(true);
		// The walker's core, kind-agnostic adapter dispatch is unchanged.
		expect(isIntegrationProviderKind('mailchimp')).toBe(true);
		expect(isIntegrationProviderKind('stripe')).toBe(true);
		expect(providerFor('mailchimp').kind).toBe('mailchimp');
		expect(providerFor('stripe').kind).toBe('stripe');
		expect(importProviderCatalogEntry('mailchimp').label).toBe('Mailchimp');
	});

	it('adds plugin providers as additive namespaced entries with ownership', () => {
		expect(IMPORT_PROVIDER_KINDS).toContain('plugin.crm-pack.hubspot');
		expect(isImportProviderKind('plugin.crm-pack.hubspot')).toBe(true);
		expect(isPluginImportProviderKind('plugin.crm-pack.hubspot')).toBe(true);
		expect(importProviderCatalogEntry('plugin.crm-pack.hubspot').pluginId).toBe('crm-pack');
		// Core providers are never plugin-owned, and are not exposed to the core
		// adapter dispatch as plugin kinds.
		expect(isPluginImportProviderKind('mailchimp')).toBe(false);
		expect(isIntegrationProviderKind('plugin.crm-pack.hubspot')).toBe(false);
	});

	it('rejects unknown kinds', () => {
		expect(isImportProviderKind('nope')).toBe(false);
		expect(isImportProviderKind(undefined)).toBe(false);
		expect(() => importProviderCatalogEntry('nope')).toThrow('Unknown import provider kind');
	});

	it('fails closed at load when a plugin kind shadows a core kind', async () => {
		vi.resetModules();
		vi.doMock('../../../plugins/importProviderCatalog.generated', () => ({
			BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG: Object.freeze([
				Object.freeze({
					kind: 'mailchimp',
					pluginId: 'crm-pack',
					label: 'Shadow of a core kind',
					attestSource: null,
					requiredEnvVars: Object.freeze([]),
					signature: Object.freeze({
						header: 'x-sig',
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: 'PLUGIN_CRM_PACK_SECRET',
					}),
					requiredCapability: 'imports:provide',
				}),
			]),
		}));
		await expect(import('../catalog')).rejects.toThrow(
			'Import provider kinds (core + bundled plugin) must be unique'
		);
		vi.doUnmock('../../../plugins/importProviderCatalog.generated');
		vi.resetModules();
	});
});
