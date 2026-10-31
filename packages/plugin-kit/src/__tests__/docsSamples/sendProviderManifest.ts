/*
 * The send-provider authoring guide's centrepiece: ONE manifest declaring all
 * three executable halves of a bundle.
 *
 * EVERY NAME HERE IS THE ONE THE SCAFFOLD EMITS for this plugin id
 * (`owlat plugins create acme-relay --template send-provider`): the variable
 * names, the two signature headers and the credential keys. A reader diffing the
 * page against their scaffolded package is the most common way this sample is
 * read, and a sample that named variables no scaffolded bundle has would make
 * that diff noise. `scaffoldedProviderConformance.test.ts` binds the two.
 */
// #region send-provider-manifest
import { definePlugin, PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';

export const acmeRelayPlugin = definePlugin({
	id: 'acme-relay',
	version: '1.0.0',
	capabilities: [PLUGIN_SEND_TRANSPORT_CAPABILITY],
	// Deployment-wide: the plugin is off until both are set. The signing secret
	// belongs HERE and not on the transport — without it the feedback route can
	// verify nothing and answers every delivery 503.
	flag: {
		default: false,
		requiredEnvVars: ['ACME_RELAY_ENABLED', 'PLUGIN_ACME_RELAY_WEBHOOK_SECRET'],
	},
	contributes: {
		sendTransports: [
			{
				id: 'relay',
				label: 'Acme Relay',
				module: { exportPath: './convex/transport' },
				retryDelays: [1_000, 5_000],
				// THIS TRANSPORT's own configuration: resolved per named instance
				// (`PLUGIN_ACME_RELAY_API_KEY__EU` for `plugin.acme-relay.relay#eu`) and
				// handed to `send` keyed by the base name.
				requiredEnvVars: ['PLUGIN_ACME_RELAY_API_KEY'],
				optionalEnvVars: ['PLUGIN_ACME_RELAY_REGION'],
				credentialFields: [
					{
						kind: 'secret',
						key: 'apiKey',
						label: 'API key',
						required: true,
						envVar: 'PLUGIN_ACME_RELAY_API_KEY',
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
						envVar: 'PLUGIN_ACME_RELAY_REGION',
					},
				],
				// `no` is the only value this tier may declare.
				supportsCustomReturnPath: 'no',
				messageIdSource: 'provider',
				deduplicatesOnIdempotencyKey: false,
				// Declaring a webhook IS `hasProviderFeedback: true` for this kind.
				webhook: {
					module: { exportPath: './convex/webhook' },
					signature: {
						header: 'x-acme-relay-signature',
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: 'PLUGIN_ACME_RELAY_WEBHOOK_SECRET',
						// REQUIRED: without replay provisions a captured request verifies
						// forever. The host signs `<timestamp>.<rawBody>`.
						replay: { timestampHeader: 'x-acme-relay-timestamp', toleranceSeconds: 300 },
					},
				},
				// Declaring an identity IS `domainVerification: 'api'` for this kind.
				domainIdentity: { module: { exportPath: './convex/domainIdentity' } },
			},
		],
	},
});
// #endregion send-provider-manifest
