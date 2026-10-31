// #region send-transport-module
import type {
	PluginSendAttempt,
	PluginSendTransportConfig,
	PluginSendTransportModule,
	PluginSendTransportParams,
} from '@owlat/plugin-kit';

interface RelayExtras {
	readonly endpoint: string;
}

/** One attempt only. Owlat owns retries, health, routing, and audit. */
export const transport: PluginSendTransportModule<RelayExtras> = {
	parseExtras(input: unknown): RelayExtras {
		if (typeof input !== 'object' || input === null) {
			throw new TypeError('extras must be an object');
		}
		const endpoint = (input as { endpoint?: unknown }).endpoint;
		if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
			throw new TypeError('extras.endpoint must be an https URL');
		}
		return { endpoint };
	},

	async send(
		params: PluginSendTransportParams,
		extras: RelayExtras,
		// THIS INSTANCE's credentials, keyed by the name the manifest declared.
		// Never `process.env`: that reads the deployment-default instance's token
		// whichever transport id the send was addressed to.
		config: PluginSendTransportConfig
	): Promise<PluginSendAttempt> {
		const response = await fetch(extras.endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${config.env['PLUGIN_ACME_TOKEN'] ?? ''}`,
			},
			body: JSON.stringify({ to: params.to, from: params.from, subject: params.subject }),
		});
		if (response.status === 429) return { success: false, code: 'rate_limited' };
		if (!response.ok) return { success: false, code: 'temporary_failure' };
		return { success: true, id: response.headers.get('x-message-id') ?? '' };
	},
};
// #endregion send-transport-module
