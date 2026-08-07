/**
 * P3.1 — CONTRACT PARITY, the artifact half.
 *
 * The send-transport catalog is what the backend composes its send-provider
 * catalog from, so a capability a manifest declares is only real once it reaches
 * this file. Three properties are pinned here:
 *
 *  1. A manifest that declares NOTHING new renders byte-identically to what the
 *     older contract emitted — the whole reason every field is optional.
 *  2. A transport that declares its own configuration is gated on the UNION of
 *     that and the plugin's flag variables, while only its OWN travel as
 *     `instanceEnvVars` — which is what the transport resolver suffixes, so a
 *     deployment-wide switch never needs a `__<INSTANCEKEY>` copy of itself.
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
			'credentialFields',
			'supportsCustomReturnPath',
			'messageIdSource',
			'deduplicatesOnIdempotencyKey',
			'hasProviderFeedback',
			'domainVerification',
		]) {
			expect(catalog).not.toContain(field);
		}
	});

	it('gates a transport that declares its own configuration on the UNION', () => {
		const catalog = compose({
			requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
			optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
		});

		// THE GATE IS BOTH LISTS. `providerKindConfigured` is exactly
		// `requiredEnvVars.every(isEnvPresent)`, and a transport whose own token is
		// set inside a plugin nobody enabled is refused by the authoritative dispatch
		// path forever — so reporting it configured is a permanent mis-assignment on
		// the campaign cell seam's measurement row, not a transient one.
		expect(catalog).toContain(
			'requiredEnvVars: Object.freeze(["MAIL_PACK_ENABLED","PLUGIN_POSTMARK_TOKEN"])'
		);
		expect(catalog).toContain('optionalEnvVars: Object.freeze(["PLUGIN_POSTMARK_STREAM"])');
		// THE SUFFIXABLE HALF IS STILL ONLY THE TRANSPORT'S OWN. Required and
		// optional together: both are resolved per instance and handed to the module,
		// and both are what a named instance reads under its suffix. The flag variable
		// is a deployment-wide switch the host's authorization path checks unsuffixed,
		// and `transports.ts` suffixes exactly what is listed here — so it never
		// demands a `__<INSTANCEKEY>` copy of itself.
		expect(catalog).toContain(
			'instanceEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN","PLUGIN_POSTMARK_STREAM"])'
		);
	});

	it('keeps a flag variable OUT of the instance half, even unvalidated', () => {
		// The manifest validator refuses this overlap outright, so `compose` cannot
		// build it — hence the unvalidated composition, which is the case the
		// renderer actually has to survive: a hand-edited bundle, a partial
		// regeneration, or a manifest validated by an older kit. Emitting
		// `PLUGIN_POSTMARK_TOKEN` into `instanceEnvVars` would make `transports.ts`
		// suffix the plugin's own switch, so `#eu` would be graded configured on
		// `PLUGIN_POSTMARK_TOKEN__EU` while the unsuffixed variable that gates the
		// plugin went unchecked — a transport listed, routed to, and refused on every
		// send.
		const catalog = renderPluginComposition([
			{
				packageName: '@acme/mail-plugin',
				manifest: {
					id: 'mail-pack',
					version: '1.0.0',
					capabilities: ['send:transport'],
					flag: { default: false, requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'] },
					contributes: {
						sendTransports: [
							{
								id: 'postmark',
								label: 'Postmark',
								module: { exportPath: './transports/postmark' },
								retryDelays: [1000],
								requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
								optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
							},
						],
					},
				},
			} as unknown as BundledPlugin,
		]).sendTransportCatalog;

		// The gate still names it exactly once, unsuffixed…
		expect(catalog).toContain('requiredEnvVars: Object.freeze(["PLUGIN_POSTMARK_TOKEN"])');
		// …and the entry has no instance half at all: subtracting the flag variable
		// left the transport with nothing REQUIRED of its own, so the honest answer
		// is `instances_unsupported` rather than an instance resolved against an
		// empty requirement list.
		expect(catalog).not.toContain('instanceEnvVars');
		expect(catalog).not.toContain('optionalEnvVars');
	});

	it('refuses a transport whose only declaration is optional, before rendering anything', () => {
		// It has nothing REQUIRED of its own, so there is no honest artifact to
		// emit: gating it on an empty list would report it CONFIGURED with the
		// plugin's flag variable unset, and gating it on the flag would offer named
		// instances whose configuration nothing could check. The manifest is refused
		// instead, which is the one answer the author can act on.
		expect(() => compose({ optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'] })).toThrow(
			/optionalEnvVars must accompany at least one requiredEnvVars entry/
		);
	});

	it('carries the credential form through, joined to the variables it names', () => {
		const catalog = compose({
			requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
			optionalEnvVars: ['PLUGIN_POSTMARK_STREAM'],
			credentialFields: [
				{
					kind: 'secret',
					key: 'token',
					label: 'Server token',
					required: true,
					envVar: 'PLUGIN_POSTMARK_TOKEN',
				},
				{
					kind: 'string',
					key: 'stream',
					label: 'Message stream',
					envVar: 'PLUGIN_POSTMARK_STREAM',
				},
			],
		});

		expect(catalog).toContain('credentialFields: Object.freeze([{"kind":"secret"');
		expect(catalog).toContain('"envVar":"PLUGIN_POSTMARK_TOKEN"');
		expect(catalog).toContain('"envVar":"PLUGIN_POSTMARK_STREAM"');
	});

	it('carries the declared capability fields through verbatim', () => {
		// `no` is the only return-path value this tier may declare — the manifest
		// validator refuses the other two, so the renderer never sees them. Spelling
		// the default is still meaningful: it is what the host re-reads on the
		// artifact.
		const catalog = compose({
			supportsCustomReturnPath: 'no',
			messageIdSource: 'composed',
			deduplicatesOnIdempotencyKey: true,
		});

		expect(catalog).toContain('supportsCustomReturnPath: "no"');
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
		// A generated file that reshuffles itself is a diff nobody can review, so the
		// emitter builds `[field, literal]` pairs in one list and this reads the
		// rendered sequence back off it.
		const catalog = compose({
			requiredEnvVars: ['PLUGIN_POSTMARK_TOKEN'],
			credentialFields: [
				{
					kind: 'secret',
					key: 'token',
					label: 'Server token',
					required: true,
					envVar: 'PLUGIN_POSTMARK_TOKEN',
				},
			],
			supportsCustomReturnPath: 'no',
			deduplicatesOnIdempotencyKey: true,
		});
		const order = [
			'kind:',
			'pluginId:',
			'localId:',
			'label:',
			'retryDelays:',
			'requiredEnvVars:',
			'instanceEnvVars:',
			'credentialFields:',
			'supportsCustomReturnPath:',
			'deduplicatesOnIdempotencyKey:',
			'requiredCapability:',
		];

		const positions = order.map((field) => catalog.indexOf(field));

		expect(positions).toEqual([...positions].sort((left, right) => left - right));
		expect(order.every((field) => catalog.includes(field))).toBe(true);
	});
});
