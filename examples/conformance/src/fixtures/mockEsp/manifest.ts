/**
 * MOCK ESP — the fixture plugin ESP's manifest (the seams plan's P3.3, its
 * acceptance criterion A4).
 *
 * A COMPLETE BUNDLE, which is the point. The three example plugins beside this
 * one each exercise one trust tier of the platform; none of them is a sending
 * provider, so nothing in the repository proved that a provider shipped as a
 * PACKAGE reaches the places a provider has to reach — routing, the four
 * strategies, the deliverability fallback, the measurement plane's reference
 * arm, the return-path fold and the credential form. This manifest declares all
 * three executable halves at once (send + feedback webhook + sending-domain
 * identity) plus the capability vocabulary D4 gave the tier, and its suite
 * (`../../__tests__/pluginProviderParity.test.ts`) drives the composed result
 * through the SHIPPED core modules.
 *
 * IT IS DELIBERATELY NOT A WORKSPACE PACKAGE and deliberately not listed in
 * `plugins.config.ts`. `renderPluginComposition` emits data-only catalogs plus
 * import statements against a published package specifier, and the suite
 * evaluates the catalogs and supplies these modules directly — so the fixture
 * proves the CONTRACT without asking the repository to install a fake registry
 * dependency. The lifecycle suite already owns the install half against the real
 * reference plugins (`../../workspace.ts`).
 *
 * WHAT IT MAY NOT DECLARE is as load-bearing as what it does. `@acme/mock-esp`
 * is written as a third-party author would write it, so every value here is one
 * the kit accepts from a stranger: `supportsCustomReturnPath: 'no'` because the
 * VERP local part is signed with a deployment secret this tier is never handed,
 * and no `acceptanceSemantics` at all because custody of an in-flight message is
 * the own MTA's. The suite pins both boundaries rather than working around them.
 */

import {
	definePlugin,
	parsePluginId,
	parsePluginLocalId,
	pluginNamespacedKind,
} from '@owlat/plugin-kit';

/** The package a third-party author would publish this bundle as. */
export const MOCK_ESP_PACKAGE_NAME = '@acme/mock-esp';

/** The plugin id; the feedback route is `/webhooks/plugin/<this>`. */
export const MOCK_ESP_PLUGIN_ID = parsePluginId('mock-esp');

/** The transport's local id; the composed kind is `plugin.mock-esp.relay`. */
export const MOCK_ESP_LOCAL_ID = parsePluginLocalId('relay');

/**
 * The composed transport kind, BUILT ONCE for the whole fixture.
 *
 * Through the grammar's single builder rather than spelled, which is the rule
 * `namespacedKindGrammar.test.ts` holds every reference plugin to: the
 * `plugin.<pluginId>.<localId>` shape is a security boundary (core-vs-plugin
 * dispatch and every ownership compare read it), so nothing outside
 * `@owlat/plugin-kit` constructs one inline.
 */
export const MOCK_ESP_KIND: string = pluginNamespacedKind(MOCK_ESP_PLUGIN_ID, MOCK_ESP_LOCAL_ID);

/** The transport's own credential — resolved per instance and handed to `send`. */
export const MOCK_ESP_TOKEN_ENV = 'PLUGIN_MOCK_ESP_TOKEN';

/** An optional refinement, so the fixture exercises a non-required descriptor. */
export const MOCK_ESP_REGION_ENV = 'PLUGIN_MOCK_ESP_REGION';

/** The host-verified webhook signing secret. Never seen by plugin code. */
export const MOCK_ESP_WEBHOOK_SECRET_ENV = 'PLUGIN_MOCK_ESP_WEBHOOK_SECRET';

/** The plugin's deployment-wide enablement switch, distinct from the credential. */
export const MOCK_ESP_ENABLED_ENV = 'MOCK_ESP_ENABLED';

/** Signature headers the fixture's provider is imagined to send. */
export const MOCK_ESP_SIGNATURE_HEADER = 'x-mock-esp-signature';
export const MOCK_ESP_TIMESTAMP_HEADER = 'x-mock-esp-timestamp';

/** The declared replay window, in seconds; the host clamps it again on load. */
export const MOCK_ESP_TOLERANCE_SECONDS = 300;

export const mockEspPlugin = definePlugin({
	id: MOCK_ESP_PLUGIN_ID,
	version: '1.0.0',
	capabilities: ['send:transport'],
	/**
	 * THE ENABLEMENT GATE, and it carries the WEBHOOK SECRET rather than the send
	 * credential. The two lists answer different questions: `requiredEnvVars` on
	 * the transport is what one INSTANCE needs (and therefore what takes an
	 * `__<INSTANCEKEY>` suffix), while this is what the whole plugin needs before
	 * any of it is considered configured. The signing secret belongs here because
	 * it is deployment-wide — without it the route can verify nothing and answers
	 * every delivery 503 — and it must NOT appear in the transport's list, which
	 * the composition refuses precisely to keep the two scopes apart.
	 */
	flag: {
		default: false,
		requiredEnvVars: [MOCK_ESP_ENABLED_ENV, MOCK_ESP_WEBHOOK_SECRET_ENV],
	},
	contributes: {
		sendTransports: [
			{
				id: MOCK_ESP_LOCAL_ID,
				label: 'Mock ESP',
				module: { exportPath: './convex/transport' },
				// Two bounded delays: enough for the dispatch loop to read them off the
				// composed entry, few enough to stay inside the kit's cap.
				retryDelays: [1_000, 5_000],
				requiredEnvVars: [MOCK_ESP_TOKEN_ENV],
				optionalEnvVars: [MOCK_ESP_REGION_ENV],
				credentialFields: [
					{
						kind: 'secret',
						key: 'token',
						label: 'API token',
						description: `Issued in the Mock ESP console. Written to ${MOCK_ESP_TOKEN_ENV}.`,
						required: true,
						envVar: MOCK_ESP_TOKEN_ENV,
					},
					{
						kind: 'select',
						key: 'region',
						label: 'Sending region',
						options: [
							{ value: 'eu', label: 'Europe' },
							{ value: 'us', label: 'United States' },
						],
						default: 'eu',
						envVar: MOCK_ESP_REGION_ENV,
					},
				],
				// Spelled rather than omitted: `no` is the only value this tier has,
				// and writing it is what the host re-reads on the generated artifact.
				supportsCustomReturnPath: 'no',
				messageIdSource: 'provider',
				deduplicatesOnIdempotencyKey: false,
				webhook: {
					module: { exportPath: './convex/webhook' },
					signature: {
						header: MOCK_ESP_SIGNATURE_HEADER,
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: MOCK_ESP_WEBHOOK_SECRET_ENV,
						replay: {
							timestampHeader: MOCK_ESP_TIMESTAMP_HEADER,
							toleranceSeconds: MOCK_ESP_TOLERANCE_SECONDS,
						},
					},
				},
				domainIdentity: { module: { exportPath: './convex/domainIdentity' } },
			},
		],
	},
});
