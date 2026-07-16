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
				secretEnvVar: 'HUBSPOT_WEBHOOK_SECRET',
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
});
