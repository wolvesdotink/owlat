/**
 * P3.2 — PLUGIN DOMAIN IDENTITY, the artifact half.
 *
 * A manifest's `domainIdentity` declaration only becomes real when it reaches
 * two generated files: the CATALOG the host composes its sending-domain provider
 * registry from, and the MODULE registry the identity action calls. Three
 * properties are pinned here:
 *
 *  1. A transport that declares no identity contributes nothing to either
 *     artifact — the whole tier stays exactly as it composed before.
 *  2. A declared identity is keyed by the NAMESPACED kind, which is what makes
 *     its rows land in `sendingDomainRelayIdentities` under
 *     `providerKind: 'plugin.<id>.<local>'` (D10: rows, not columns), and carries
 *     the transport's OWN configuration — never the plugin's deployment-wide flag
 *     variables, which are not this transport's to hand to a module.
 *  3. `domainVerification: 'api'` on the SEND catalog entry is DERIVED from the
 *     same declaration, so a transport cannot promise a proof it ships no module
 *     for, nor ship one the routing gate never reads.
 *
 * The module registry is deliberately NOT `'use node'`: it is composed into
 * `domains/providers/`, which the enqueue transaction reads.
 */

import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import { renderPluginComposition } from '../render';

function compose(transport: Record<string, unknown>) {
	const [plugin] = composeBundledPlugins([
		{
			packageName: '@acme/mail-plugin',
			manifest: {
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: ['send:transport'],
				flag: { default: false, requiredEnvVars: ['MAIL_PACK_ENABLED'] },
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
	return renderPluginComposition([plugin]);
}

const IDENTITY = {
	requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
	optionalEnvVars: ['PLUGIN_POSTMARK_REGION'],
	domainIdentity: { module: { exportPath: './domains/postmark' } },
};

describe('a transport that declares no sending-domain identity', () => {
	it('contributes nothing to either artifact', () => {
		const composition = compose({ requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'] });

		expect(composition.sendTransportDomainIdentityCatalog).toContain(
			'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG = Object.freeze([] as const)'
		);
		expect(composition.sendTransportDomainIdentityModules).toContain(
			'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES = Object.freeze([] as const)'
		);
		// The word `api` is a promise three host paths read; absent means the
		// catalog's fail-closed `none`.
		expect(composition.sendTransportCatalog).not.toContain('domainVerification');
	});
});

describe('a declared sending-domain identity', () => {
	it('is keyed by the namespaced kind the identity rows are written under', () => {
		const catalog = compose(IDENTITY).sendTransportDomainIdentityCatalog;

		expect(catalog).toContain('kind: "plugin.mail-pack.postmark"');
		expect(catalog).toContain('pluginId: "mail-pack"');
		expect(catalog).toContain('localId: "postmark"');
		expect(catalog).toContain('label: "Postmark"');
		expect(catalog).toContain("requiredCapability: 'send:transport'");
	});

	it('carries the transport’s own configuration and not the plugin’s flag variables', () => {
		const catalog = compose(IDENTITY).sendTransportDomainIdentityCatalog;

		// The module is handed exactly these, keyed by base name. A flag variable in
		// this list would have the host demand a `__<INSTANCEKEY>` copy of a
		// deployment-wide switch — and would hand a plugin's own gate to third-party
		// code as if it were a transport credential.
		expect(catalog).toContain(
			'instanceEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN","PLUGIN_POSTMARK_REGION"])'
		);
		expect(catalog).toContain('requiredEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN"])');
		expect(catalog).not.toContain('MAIL_PACK_ENABLED');
	});

	it('imports the module under a registry the isolate can load', () => {
		const modules = compose(IDENTITY).sendTransportDomainIdentityModules;

		expect(modules).toContain(
			'import bundledPluginSendTransportDomainIdentity0 from "@acme/mail-plugin/domains/postmark"'
		);
		expect(modules).toContain('satisfies PluginSendTransportDomainIdentityModule');
		expect(modules).toContain('kind: "plugin.mail-pack.postmark"');
		// `'use node'` here would drag the Node runtime onto the enqueue path, which
		// reads this registry through `domains/providers/`.
		expect(modules.startsWith("'use node'")).toBe(false);
	});

	it('derives domainVerification: api on the send catalog entry', () => {
		const composition = compose(IDENTITY);

		expect(composition.sendTransportCatalog).toContain('domainVerification: "api"');
	});
});
