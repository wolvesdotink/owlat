/**
 * Generated catalogs are build artifacts, not trusted runtime input.
 *
 * Manifest validation normally proves both rules below, but the server uses the
 * artifact to authorize deployment-env writes. Re-asserting them at module load
 * makes a hand edit, stale generator, or partial regeneration fail closed before
 * a malformed entry can become an allowlist member.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	vi.doUnmock('~/generated/sendTransportCatalog.generated');
});

function generatedCatalog(entries: readonly unknown[]): void {
	vi.doMock('~/generated/sendTransportCatalog.generated', () => ({
		BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze(entries),
	}));
}

function entry(kind: string, envVar: string) {
	return Object.freeze({
		kind,
		label: 'Malformed fixture',
		retryDelays: Object.freeze([]),
		requiredEnvVars: Object.freeze([envVar]),
		credentialFields: Object.freeze([
			Object.freeze({
				kind: 'secret',
				key: 'token',
				label: 'Token',
				required: true,
				envVar,
			}),
		]),
	});
}

describe('composed send-provider artifact guards', () => {
	it('refuses a generated entry whose transport kind is not plugin-namespaced', async () => {
		generatedCatalog([entry('postmark', 'PLUGIN_POSTMARK_TOKEN')]);

		await expect(import('../composedSendProviderCatalog')).rejects.toThrow(
			"Bundled plugin send transport kind 'postmark' is not namespaced"
		);
	});

	it('refuses a generated credential field that could authorize a core secret write', async () => {
		generatedCatalog([entry('plugin.mock-esp.relay', 'INSTANCE_SECRET')]);

		await expect(import('../composedSendProviderCatalog')).rejects.toThrow(
			"declares credential variable 'INSTANCE_SECRET' outside the plugin transport namespace"
		);
	});
});
