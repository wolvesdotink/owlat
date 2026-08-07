/**
 * P3.1 — CONTRACT PARITY, the artifact half.
 *
 * The send-transport catalog is what the backend composes its send-provider
 * catalog from, so a capability a manifest declares is only real once it reaches
 * this file. Three properties are pinned here:
 *
 *  1. A manifest that declares NOTHING new renders byte-identically to what the
 *     older contract emitted — the whole reason every field is optional.
 *  2. A transport that declares its own configuration is gated on THAT, not on
 *     the plugin's flag variables, and its variables travel as `instanceEnvVars`
 *     so the transport resolver can offer it named instances.
 *  3. `hasProviderFeedback` is DERIVED from the webhook declaration. A manifest
 *     cannot claim feedback it has no parser for, and cannot forget to claim
 *     feedback it does have.
 */

import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import { renderPluginComposition } from '../render';

function compose(transport: Record<string, unknown>, flagEnvVars?: readonly string[]): string {
	const [plugin] = composeBundledPlugins([
		{
			packageName: '@acme/mail-plugin',
			manifest: {
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: ['send:transport'],
				flag: { default: false, requiredEnvVars: flagEnvVars ?? ['MAIL_PACK_ENABLED'] },
				contributes: {
					sendTransports: [
						{
							id: 'postmark',
							label: 'Postmark',
							module: { exportPath: './transports/postmark' },
							retryDelays: [1000],
							...transport,
						},
					],
				},
			},
		} as unknown as BundledPlugin,
	]);
	if (!plugin) throw new Error('Expected plugin fixture');
	return renderPluginComposition([plugin]).sendTransportCatalog;
}

describe('bundled send transport capabilities in the generated catalog', () => {
	it('emits nothing new for a manifest written against the older contract', () => {
		const catalog = compose({});

		expect(catalog).toContain('requiredEnvVars: Object.freeze(["MAIL_PACK_ENABLED"])');
		for (const field of [
			'optionalEnvVars',
			'instanceEnvVars',
			'supportsCustomReturnPath',
			'messageIdSource',
			'deduplicatesOnIdempotencyKey',
			'hasProviderFeedback',
		]) {
			expect(catalog).not.toContain(field);
		}
	});

	it('gates a transport that declares its own configuration on ITS variables', () => {
		const catalog = compose({
			requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
			optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
		});

		expect(catalog).toContain('requiredEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN"])');
		expect(catalog).toContain('optionalEnvVars: Object.freeze(["PLUGIN_POSTMARK_STREAM"])');
		// Required and optional together: both are resolved per instance and handed
		// to the module, and both are what a named instance reads under its suffix.
		expect(catalog).toContain(
			'instanceEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN","PLUGIN_POSTMARK_STREAM"])'
		);
		// The plugin's flag variable gates the PLUGIN, unsuffixed, on the host's
		// authorization path. Folding it in here would demand a `__<INSTANCEKEY>`
		// copy of a deployment-wide switch before any named instance could resolve.
		expect(catalog).not.toContain('MAIL_PACK_ENABLED');
	});

	it('keeps the flag gate for a transport whose only declaration is optional', () => {
		// Nothing REQUIRED of its own, so the presence gate stays the plugin's — and
		// the empty required list is what makes the transport resolver refuse a named
		// instance rather than let one resolve on the default's credentials.
		const catalog = compose({ optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'] });

		expect(catalog).toContain('requiredEnvVars: Object.freeze([])');
		expect(catalog).toContain('instanceEnvVars: Object.freeze(["PLUGIN_POSTMARK_STREAM"])');
	});

	it('carries the declared capability fields through verbatim', () => {
		const catalog = compose({
			supportsCustomReturnPath: 'yes',
			messageIdSource: 'composed',
			deduplicatesOnIdempotencyKey: true,
		});

		expect(catalog).toContain('supportsCustomReturnPath: "yes"');
		expect(catalog).toContain('messageIdSource: "composed"');
		expect(catalog).toContain('deduplicatesOnIdempotencyKey: true');
	});

	it('omits a capability declared at its fail-closed default', () => {
		// `false` and the absent field mean the same thing to every accessor, so
		// emitting it would be noise the staleness check has to keep in sync.
		expect(compose({ deduplicatesOnIdempotencyKey: false })).not.toContain(
			'deduplicatesOnIdempotencyKey'
		);
	});

	it('derives hasProviderFeedback from the webhook declaration', () => {
		const withWebhook = compose(
			{
				webhook: {
					module: { exportPath: './webhooks/postmark' },
					signature: {
						header: 'x-postmark-signature',
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
						replay: { timestampHeader: 'x-postmark-timestamp', toleranceSeconds: 300 },
					},
				},
			},
			['PLUGIN_POSTMARK_WEBHOOK_SECRET']
		);

		expect(withWebhook).toContain('hasProviderFeedback: true');
		expect(compose({})).not.toContain('hasProviderFeedback');
	});

	it('renders a parseable module with the fields in a stable order', () => {
		const catalog = compose({
			requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
			supportsCustomReturnPath: 'yes',
			deduplicatesOnIdempotencyKey: true,
		});

		expect(catalog.indexOf('requiredEnvVars')).toBeLessThan(catalog.indexOf('instanceEnvVars'));
		expect(catalog.indexOf('instanceEnvVars')).toBeLessThan(
			catalog.indexOf('supportsCustomReturnPath')
		);
		expect(catalog.indexOf('deduplicatesOnIdempotencyKey')).toBeLessThan(
			catalog.indexOf('requiredCapability')
		);
	});
});
