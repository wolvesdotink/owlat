import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { SEND_PROVIDER_BUNDLES, providerBundleFor, runtimeTransportFor } from '../composition';

describe('send-provider bundle composition', () => {
	it('preserves incumbent order, catalog data, routes, and environment names', () => {
		const incumbents = SEND_PROVIDER_BUNDLES.filter(({ source }) => source !== 'third-party');
		expect(incumbents.map(({ descriptor }) => descriptor)).toEqual(
			CORE_SEND_PROVIDER_CATALOG_ENTRIES
		);
		expect(
			incumbents.map(({ descriptor, feedback }) => ({
				kind: descriptor.kind,
				required: descriptor.requiredEnvVars,
				optional: descriptor.optionalEnvVars ?? [],
				webhookPath: feedback?.webhookPath ?? null,
			}))
		).toEqual([
			{
				kind: 'mta',
				required: ['MTA_API_URL', 'MTA_API_KEY'],
				optional: ['OUTBOUND_TLS_MODE', 'MTA_WEBHOOK_SECRET'],
				webhookPath: '/webhooks/mta',
			},
			{
				kind: 'ses',
				required: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
				optional: ['SES_CONFIGURATION_SET'],
				webhookPath: '/webhooks/ses',
			},
			{
				kind: 'resend',
				required: ['RESEND_API_KEY'],
				optional: ['RESEND_WEBHOOK_SECRET'],
				webhookPath: '/webhooks/resend',
			},
			{
				kind: 'smtp',
				required: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
				optional: ['SMTP_RELAY_PORT', 'SMTP_RELAY_SECURE'],
				webhookPath: null,
			},
			{
				kind: 'mandrill',
				required: ['MANDRILL_API_KEY'],
				optional: ['MANDRILL_WEBHOOK_KEY', 'MANDRILL_SUBACCOUNT', 'MANDRILL_IP_POOL'],
				webhookPath: '/webhooks/mandrill',
			},
			{
				kind: 'emailit',
				required: ['EMAILIT_API_KEY'],
				optional: ['EMAILIT_WEBHOOK_SECRET'],
				webhookPath: '/webhooks/emailit',
			},
		]);
	});

	it('assigns trust and executable slots without a writable trust field', () => {
		expect(
			SEND_PROVIDER_BUNDLES.map(({ descriptor, source }) => [descriptor.kind, source])
		).toEqual([
			['mta', 'own'],
			['ses', 'first-party'],
			['resend', 'first-party'],
			['smtp', 'first-party'],
			['mandrill', 'first-party'],
			['emailit', 'first-party'],
		]);

		expect(providerBundleFor('mta')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/mta' },
			platformHooks: { exportPath: 'providers/mta/platformHooks' },
		});
		expect(providerBundleFor('ses')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/ses' },
			relayDomainIdentity: { exportPath: 'domains/providers/ses' },
		});
		expect(providerBundleFor('mandrill')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/mandrill' },
			relayDomainIdentity: { exportPath: 'domains/providers/mandrill' },
		});
		expect(providerBundleFor('smtp')?.feedback).toBeUndefined();
	});

	it('declares host-owned verifier mechanisms for all incumbent feedback', () => {
		expect(
			SEND_PROVIDER_BUNDLES.flatMap(({ descriptor, feedback }) =>
				feedback ? [[descriptor.kind, feedback.verifier.scheme]] : []
			)
		).toEqual([
			['mta', 'hmac-timestamp-body'],
			['ses', 'aws-sns'],
			['resend', 'svix'],
			['mandrill', 'mandrill-form'],
			['emailit', 'hmac-timestamp-body'],
		]);
	});

	/**
	 * ONE RETRY SCHEDULE PER KIND, and the catalog owns it.
	 *
	 * The literals below are the schedules the core adapters used to hold as their
	 * own constants (`MTA_RETRY_DELAYS` in `mta/index.ts`, `RETRY_DELAYS_MS` in
	 * `lib/constants.ts` for the other five), so this is the byte-level proof that
	 * moving the read to the catalog entry changed no retry behaviour: the dispatch
	 * loop runs `retryDelays.length + 1` attempts, spaced by these numbers.
	 *
	 * The identity assertion is what keeps it that way. Values alone would still
	 * pass for an adapter that copied the numbers back out into a local constant —
	 * exactly the drift this closes — whereas holding the catalog's own frozen
	 * array can only be true of an adapter that READ the declaration.
	 */
	it('drives every incumbent transport off the retry schedule its catalog entry declares', () => {
		const incumbents = SEND_PROVIDER_BUNDLES.filter(({ source }) => source !== 'third-party');
		expect(
			incumbents.map(({ descriptor }) => [
				descriptor.kind,
				[...runtimeTransportFor(descriptor.kind).retryDelays],
			])
		).toEqual([
			['mta', [1_000, 5_000]],
			['ses', [1_000, 5_000, 30_000]],
			['resend', [1_000, 5_000, 30_000]],
			['smtp', [1_000, 5_000, 30_000]],
			['mandrill', [1_000, 5_000, 30_000]],
			['emailit', [1_000, 5_000, 30_000]],
		]);
		for (const { descriptor } of incumbents) {
			expect(runtimeTransportFor(descriptor.kind).retryDelays).toBe(descriptor.retryDelays);
		}
	});
});

/**
 * THE GENERATED MODULES ARTIFACT IS NOT TRUSTED.
 *
 * The codegen cannot emit either of these, and the catalog artifact's own kinds
 * are checked in `lib/sendProviders/catalog.ts` — but neither fact is a check on
 * THIS artifact, which is what a hand edit, a bad merge or a partial
 * regeneration actually produces. Both mistakes are silent without the guard: a
 * core kind never consults the modules artifact, and `new Map` resolves a
 * duplicate last-write-wins, so one contributing plugin would quietly lose the
 * transport it owns. A deployment mistake must stop the deployment.
 */
describe('bundled send transport modules artifact', () => {
	const MODULES = '../../plugins/sendTransportModules.generated';

	async function composeWithModules(modules: readonly unknown[]): Promise<unknown> {
		vi.resetModules();
		vi.doMock(MODULES, () => ({ BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: modules }));
		return import('../composition');
	}

	afterEach(() => {
		vi.doUnmock(MODULES);
		vi.resetModules();
	});

	it('refuses a module that claims a core kind', async () => {
		await expect(
			composeWithModules([{ kind: 'ses', pluginId: 'mail-pack', module: {} }])
		).rejects.toThrow("Bundled send transport 'ses' may not claim a core kind");
	});

	it('refuses two modules that claim the same kind', async () => {
		const kind = 'plugin.mail-pack.postmark';
		await expect(
			composeWithModules([
				{ kind, pluginId: 'mail-pack', module: {} },
				{ kind, pluginId: 'other-pack', module: {} },
			])
		).rejects.toThrow(`Bundled send transport '${kind}' has more than one owned module`);
	});

	it('composes the shipped artifact without complaint', async () => {
		await expect(composeWithModules([])).resolves.toBeDefined();
	});
});

/**
 * A PLUGIN WEBHOOK, RESTATED IN THE HOST'S VERIFIER VOCABULARY.
 *
 * `providers/feedback.ts:pluginVerifier` is the seam that makes a plugin kind
 * indistinguishable from a core one to everything downstream — the verifier
 * registry that enforces the scheme, and `feedbackVerifierEnvVars`, which is
 * what tells an operator which variable is missing. It is a TRANSLATION, so the
 * failure it can have is naming the wrong arm: a Svix contract restated as the
 * parameterized HMAC would recompute a different string and reject every real
 * delivery, and its `secretEnvVar` would still look configured.
 */
describe('a bundled webhook reaches the verifier registry as its own scheme', () => {
	const SEND_CATALOG = '../../plugins/sendTransportCatalog.generated';
	const MODULES = '../../plugins/sendTransportModules.generated';
	const WEBHOOK_CATALOG = '../../plugins/sendTransportWebhookCatalog.generated';
	const WEBHOOK_MODULES = '../../plugins/sendTransportWebhookModules.generated';
	const KIND = 'plugin.mail-pack.relay';
	const PLUGIN_ID = 'mail-pack';

	async function composeWithSignature(signature: unknown) {
		vi.resetModules();
		vi.doMock(SEND_CATALOG, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
				Object.freeze({
					kind: KIND,
					pluginId: PLUGIN_ID,
					localId: 'relay',
					label: 'Relay',
					retryDelays: Object.freeze([0]),
					requiredEnvVars: Object.freeze([]),
					requiredCapability: 'send:transport',
				}),
			]),
		}));
		vi.doMock(MODULES, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: Object.freeze([
				Object.freeze({
					kind: KIND,
					pluginId: PLUGIN_ID,
					module: { parseExtras: () => ({}), send: async () => ({ success: true, id: 'x' }) },
				}),
			]),
		}));
		vi.doMock(WEBHOOK_CATALOG, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: Object.freeze([
				Object.freeze({
					kind: KIND,
					pluginId: PLUGIN_ID,
					localId: 'relay',
					signature,
					storeRawPayload: false,
					requiredCapability: 'send:transport',
				}),
			]),
		}));
		vi.doMock(WEBHOOK_MODULES, () => ({
			BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: Object.freeze([
				Object.freeze({ kind: KIND, pluginId: PLUGIN_ID, module: { parseEvents: () => [] } }),
			]),
		}));
		const feedback = (await import('../feedback')) as typeof import('../feedback');
		return feedback.providerFeedbackFor(KIND as never);
	}

	afterEach(() => {
		for (const path of [SEND_CATALOG, MODULES, WEBHOOK_CATALOG, WEBHOOK_MODULES]) {
			vi.doUnmock(path);
		}
		vi.resetModules();
	});

	it('restates the svix arm as the host’s svix scheme', async () => {
		const contribution = await composeWithSignature(
			Object.freeze({
				scheme: 'svix',
				secretEnvVar: 'PLUGIN_RELAY_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			})
		);
		expect(contribution?.webhookPath).toBe(`/webhooks/plugin/${PLUGIN_ID}`);
		expect(contribution?.verifier).toEqual({
			scheme: 'svix',
			secretEnvVar: 'PLUGIN_RELAY_WEBHOOK_SECRET',
			toleranceSeconds: 300,
		});
	});

	it('restates the default arm exactly as it always did', async () => {
		const contribution = await composeWithSignature(
			Object.freeze({
				header: 'x-relay-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'PLUGIN_RELAY_WEBHOOK_SECRET',
				replay: Object.freeze({ timestampHeader: 'x-relay-timestamp', toleranceSeconds: 300 }),
			})
		);
		expect(contribution?.verifier).toEqual({
			scheme: 'hmac-timestamp-body',
			algorithm: 'sha256',
			encoding: 'hex',
			signatureHeader: 'x-relay-signature',
			timestampHeader: 'x-relay-timestamp',
			secretEnvVar: 'PLUGIN_RELAY_WEBHOOK_SECRET',
			toleranceSeconds: 300,
		});
	});
});
