/**
 * THE UNTYPED TIER CANNOT DECLARE CUSTODY (plan P0.1 / D2).
 *
 * `CoreSendProviderCatalogEntry` makes `acceptanceSemantics: 'accepted'` and
 * `messageIdSource: 'idempotency-key'` a compile-time proposition for the five
 * kinds that ship in this repo, but bundled plugin entries are GENERATED and
 * reach the catalog through a cast, so the type says nothing about them. The
 * prerequisites those two values carry — `bindMtaProviderIdentity` stamping
 * `providerType: 'mta'`, and `withReconciliationSafety` deferring every
 * non-`mta` replay until the delivery deadline terminalizes it — are outside
 * this file and outside a manifest author's view. A prose note is not a control,
 * so `catalog.ts` refuses either declaration at composition time.
 *
 * Nothing can reach that guard today (the plugin codegen emits no semantics
 * fields at all), which is exactly why it needs a test: the whole api suite
 * would stay green if the check were deleted. These cases compose the catalog
 * against generated entries that DO carry the fields — the shape plan P3.1
 * makes possible — and assert the module refuses to load rather than shipping a
 * plugin whose sends are attributed to the own arm.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const GENERATED = '../../../plugins/sendTransportCatalog.generated';

/** The shape `renderSendTransportCatalog` emits, plus whatever P3.1 adds. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
	return Object.freeze({
		kind: 'plugin.mail-pack.hosted',
		pluginId: 'mail-pack',
		localId: 'hosted',
		label: 'Hosted transport',
		retryDelays: Object.freeze([0]),
		requiredEnvVars: Object.freeze([]),
		requiredCapability: 'send:transport',
		...overrides,
	});
}

/**
 * Compose a FRESH catalog module over a mocked generated catalog. The guard runs
 * at module scope, so the assertion is on the import itself — which means the
 * module registry has to be reset first, or the already-loaded real catalog
 * would be handed back and every case would pass vacuously.
 */
async function composeCatalogWith(generated: readonly unknown[]): Promise<unknown> {
	vi.resetModules();
	vi.doMock(GENERATED, () => ({ BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: generated }));
	return import('../catalog');
}

afterEach(() => {
	vi.doUnmock(GENERATED);
	vi.resetModules();
});

describe('composing the catalog with a bundled plugin transport', () => {
	it('refuses one that claims CUSTODY of the message', async () => {
		await expect(composeCatalogWith([entry({ acceptanceSemantics: 'accepted' })])).rejects.toThrow(
			/acceptanceSemantics: accepted/
		);
	});

	it('refuses one that claims the message id is OURS', async () => {
		// Independently dangerous, and by a different route: this one alone turns
		// on the pre-dispatch identity binding, whose mutation patches
		// `providerType: 'mta'` onto the Send regardless of which kind sent it.
		await expect(
			composeCatalogWith([entry({ messageIdSource: 'idempotency-key' })])
		).rejects.toThrow(/messageIdSource: idempotency-key/);
	});

	it('names the entry and points at the one place the prerequisites are written', async () => {
		await expect(
			composeCatalogWith([
				entry({ kind: 'plugin.mail-pack.custodian', acceptanceSemantics: 'accepted' }),
			])
		).rejects.toThrow(
			/plugin\.mail-pack\.custodian[\s\S]*PREREQUISITES note on AcceptanceSemantics/
		);
	});

	it('admits every declaration whose prerequisites are already met', async () => {
		// The guard is deliberately NOT the core union: an entry may pair
		// `unknown-on-timeout` with any id source, including one it composed
		// itself, and an entry may still declare nothing at all. Only the two
		// values with prerequisites outside the catalog are refused.
		const admitted = (await composeCatalogWith([
			entry({ kind: 'plugin.mail-pack.a' }),
			entry({
				kind: 'plugin.mail-pack.b',
				acceptanceSemantics: 'unknown-on-timeout',
				messageIdSource: 'provider',
			}),
			entry({
				kind: 'plugin.mail-pack.c',
				acceptanceSemantics: 'unknown-on-timeout',
				messageIdSource: 'composed',
			}),
		])) as { SEND_PROVIDER_KINDS: readonly string[] };

		expect(admitted.SEND_PROVIDER_KINDS).toEqual(
			expect.arrayContaining(['plugin.mail-pack.a', 'plugin.mail-pack.b', 'plugin.mail-pack.c'])
		);
	});
});
