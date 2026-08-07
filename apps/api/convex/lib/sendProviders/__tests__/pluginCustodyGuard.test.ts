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
 * Since plugin-tier contract parity (the seams plan's P3.1) a manifest CAN carry
 * capability fields, and the kit's own unions already refuse these two words —
 * so this is the artifact-level backstop of a rule an author now meets earlier.
 * It still needs a test, and for the original reason: this repo bundles no
 * plugin, so the whole api suite would stay green if the check were deleted.
 * These cases compose the catalog against generated entries that DO carry the
 * fields and assert the module refuses to load rather than shipping a plugin
 * whose sends are attributed to the own arm.
 *
 * The file also covers the parity fields' OWN composition guard — the `PLUGIN_`
 * namespace an `instanceEnvVars` name must live in, which is the one plugin
 * declaration whose VALUE the host reads and hands to third-party code, and HOW
 * MANY such names an entry may carry, which is a per-send cost the artifact pays
 * rather than a rule the manifest merely promised.
 */

import { existsSync } from 'node:fs';
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

	it('refuses one whose configuration variable is outside the plugin namespace', async () => {
		// `instanceEnvVars` is the one plugin declaration whose VALUES the host reads
		// and hands to third-party code (the seams plan's P3.1), so the namespace is
		// a security floor rather than a naming convention: an entry naming
		// `MTA_API_KEY` would be handed this deployment's own MTA credential. The
		// manifest validator enforces it at authoring time; this is the artifact's
		// backstop, and the artifact is what actually runs.
		await expect(
			composeCatalogWith([entry({ instanceEnvVars: Object.freeze(['MTA_API_KEY']) })])
		).rejects.toThrow(/MTA_API_KEY[\s\S]*PLUGIN_ namespace/);
		await expect(
			composeCatalogWith([entry({ instanceEnvVars: Object.freeze(['PLUGIN_TOKEN__EU']) })])
		).rejects.toThrow(/PLUGIN_ namespace/);
	});

	it('refuses a CREDENTIAL FORM naming a variable outside the namespace', async () => {
		// A descriptor's `envVar` is never read by the host — it is what a setup
		// surface writes an operator's input INTO. An artifact whose form named
		// `MTA_API_KEY` would offer to overwrite this deployment's own credential
		// from a plugin's panel.
		await expect(
			composeCatalogWith([
				entry({
					credentialFields: Object.freeze([
						Object.freeze({
							kind: 'secret',
							key: 'token',
							label: 'Token',
							required: true,
							envVar: 'MTA_API_KEY',
						}),
					]),
				}),
			])
		).rejects.toThrow(/MTA_API_KEY[\s\S]*PLUGIN_ namespace/);
	});

	it('refuses an artifact that would make every send attempt read thousands of variables', async () => {
		// The namespace bound above and this one are the same argument: the kit's
		// rule is only a rule where it is enforced, and the ARTIFACT is what runs.
		// The cost here is per-send rather than security — `resolveHostedConfig`
		// reads every `instanceEnvVars` entry on each attempt, and again on each
		// retry — which is exactly why a bound that only manifest validation applies
		// is not a bound at all.
		const many = Object.freeze(
			Array.from({ length: 5_000 }, (_, index) => `PLUGIN_MAIL_PACK_V${index}`)
		);

		await expect(composeCatalogWith([entry({ instanceEnvVars: many })])).rejects.toThrow(
			/declares 5000 instanceEnvVars[\s\S]*every send attempt/
		);
	});

	it('refuses a credential FORM past the same bound', async () => {
		const many = Object.freeze(
			Array.from({ length: 13 }, (_, index) =>
				Object.freeze({
					kind: 'string',
					key: `field${index}`,
					label: `Field ${index}`,
					envVar: `PLUGIN_MAIL_PACK_V${index}`,
				})
			)
		);

		await expect(composeCatalogWith([entry({ credentialFields: many })])).rejects.toThrow(
			/declares 13 credentialFields/
		);
	});

	it('ADMITS the dedup claim, which the module half of the promise now backs', async () => {
		// Until plugin-tier parity this was refused outright, because the tier had no
		// per-send extras contract and the key could never reach the provider. It has
		// one now, so the claim is legal HERE and its other half is checked where the
		// modules are: `lib/sendProviders/index.ts` refuses to register a transport
		// that declares it without exporting `buildSystemMailExtras` — pinned by
		// `pluginCapabilityParity.test.ts`.
		const admitted = (await composeCatalogWith([
			entry({ deduplicatesOnIdempotencyKey: true }),
		])) as { SEND_PROVIDER_KINDS: readonly string[] };

		expect(admitted.SEND_PROVIDER_KINDS).toContain('plugin.mail-pack.hosted');
	});

	it('sends the manifest author to files that actually declare what the message names', async () => {
		// A BOOT FAILURE IS A ONE-SHOT EXPLANATION. Whoever hits it is reading the
		// string, not the codebase, so a pointer at the wrong file costs them the
		// hunt the message exists to save — and asserting only that the identifier
		// appears cannot tell a right path from a wrong one.
		// SEQUENTIALLY, not `Promise.all`: `composeCatalogWith` resets and re-mocks
		// ONE module registry, so overlapping compositions can both observe the last
		// mock and quietly assert the same message twice.
		const messages: string[] = [];
		for (const candidate of [
			entry({ kind: 'plugin.mail-pack.custodian', acceptanceSemantics: 'accepted' }),
			entry({ kind: 'plugin.mail-pack.owner', messageIdSource: 'idempotency-key' }),
			entry({
				kind: 'plugin.mail-pack.borrower',
				instanceEnvVars: Object.freeze(['MTA_API_KEY']),
			}),
			entry({
				kind: 'plugin.mail-pack.greedy',
				instanceEnvVars: Object.freeze(
					Array.from({ length: 13 }, (_, index) => `PLUGIN_MAIL_PACK_V${index}`)
				),
			}),
			entry({
				kind: 'plugin.mail-pack.verbose',
				credentialFields: Object.freeze(
					Array.from({ length: 13 }, (_, index) =>
						Object.freeze({
							kind: 'string',
							key: `field${index}`,
							label: `Field ${index}`,
							envVar: `PLUGIN_MAIL_PACK_V${index}`,
						})
					)
				),
			}),
		]) {
			messages.push(
				await composeCatalogWith([candidate]).then(
					() => '',
					(error: unknown) => (error as Error).message
				)
			);
		}
		const { readFileSync } = await import('node:fs');
		const { dirname, resolve } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		// Repo-root relative, because a pointer may name either half of the catalog:
		// the declaration vocabulary lives in `packages/shared`, the machinery that
		// reads it in `apps/api/convex`.
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
		for (const message of messages) {
			const pointer = /See (?:the PREREQUISITES note on )?(\w+) in (\S+\.ts)/;
			const [, symbol, path] = pointer.exec(message) ?? [];
			expect({ message, symbol, path }).toMatchObject({
				symbol: expect.any(String),
				path: expect.any(String),
			});
			const onDisk = [resolve(repoRoot, path!), resolve(repoRoot, 'apps/api/convex', path!)].find(
				(candidate) => existsSync(candidate)
			);
			expect({ path, onDisk }).toMatchObject({ onDisk: expect.any(String) });
			expect(readFileSync(onDisk!, 'utf8')).toContain(symbol!);
		}
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
			entry({ kind: 'plugin.mail-pack.d', deduplicatesOnIdempotencyKey: false }),
		])) as { SEND_PROVIDER_KINDS: readonly string[] };

		expect(admitted.SEND_PROVIDER_KINDS).toEqual(
			expect.arrayContaining([
				'plugin.mail-pack.a',
				'plugin.mail-pack.b',
				'plugin.mail-pack.c',
				'plugin.mail-pack.d',
			])
		);
	});
});
