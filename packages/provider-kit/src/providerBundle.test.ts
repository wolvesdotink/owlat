import { describe, expect, it } from 'vitest';
import {
	composeProviderBundles,
	defineSendProviderBundle,
	ProviderBundleCompositionError,
} from './providerBundle';

const transport = { send: async () => ({ success: true as const, id: 'id' }) };

function bundle(kind: string) {
	return defineSendProviderBundle({
		descriptor: {
			kind,
			label: kind,
			retryDelays: [1_000],
			requiredEnvVars: [`PLUGIN_${kind.toUpperCase()}_KEY`],
		},
		transport,
	});
}

describe('composeProviderBundles', () => {
	it('preserves order and assigns provenance outside the manifest', () => {
		const composed = composeProviderBundles([
			{ source: 'first-party', bundle: bundle('ses') },
			{ source: 'third-party', bundle: bundle('external') },
		]);
		expect(composed.map(({ descriptor, source }) => [descriptor.kind, source])).toEqual([
			['ses', 'first-party'],
			['external', 'third-party'],
		]);
		expect(Object.isFrozen(composed)).toBe(true);
	});

	it('rejects duplicate kinds and routes', () => {
		expect(() =>
			composeProviderBundles([
				{ source: 'first-party', bundle: bundle('same') },
				{ source: 'third-party', bundle: bundle('same') },
			])
		).toThrow(ProviderBundleCompositionError);

		const withRoute = (kind: string) => ({
			...bundle(kind),
			feedback: {
				webhookPath: '/webhooks/shared',
				verifier: {
					scheme: 'hmac-timestamp-body' as const,
					algorithm: 'sha256' as const,
					encoding: 'hex' as const,
					signatureHeader: 'x-signature',
					timestampHeader: 'x-timestamp',
					secretEnvVar: 'PLUGIN_TEST_SECRET',
					toleranceSeconds: 300,
				},
				parser: { parseEvents: () => [] },
			},
		});
		expect(() =>
			composeProviderBundles([
				{ source: 'first-party', bundle: withRoute('a') },
				{ source: 'third-party', bundle: withRoute('b') },
			])
		).toThrow(/Duplicate provider feedback route/);
	});

	it.each([
		['custody', { acceptanceSemantics: 'accepted' as const }],
		['pre-dispatch identity', { messageIdSource: 'idempotency-key' as const }],
		['feedback provenance', { tagsFeedbackProvenance: true }],
	])('rejects third-party %s claims', (_name, claim) => {
		expect(() =>
			composeProviderBundles([
				{
					source: 'third-party',
					bundle: {
						...bundle('external'),
						descriptor: { ...bundle('external').descriptor, ...claim },
					},
				},
			])
		).toThrow(/own-only/);
	});

	it('reserves platform hooks and primary identities by source', () => {
		expect(() =>
			composeProviderBundles([
				{
					source: 'first-party',
					bundle: { ...bundle('ses'), platformHooks: {} },
				},
			])
		).toThrow(/platform hooks/);
		expect(() =>
			composeProviderBundles([
				{
					source: 'third-party',
					bundle: { ...bundle('external'), primaryDomainIdentity: {} },
				},
			])
		).toThrow(/primary domain identity/);
	});
});
