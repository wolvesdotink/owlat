// #region send-transport-webhook-module
import type {
	PluginSendTransportWebhookModule,
	PluginWebhookFeedbackEvent,
} from '@owlat/plugin-kit';

/** Parse ONLY: these bytes are already verified, fresh, and not a replay. */
export const webhook: PluginSendTransportWebhookModule = {
	parseEvents(rawBody: string): readonly PluginWebhookFeedbackEvent[] {
		const batch = JSON.parse(rawBody) as { readonly records?: readonly unknown[] };
		return (batch.records ?? []).flatMap((record) => {
			const { type, id, at } = record as { type?: string; id?: string; at?: number };
			if (type !== 'HardBounce' || typeof id !== 'string' || typeof at !== 'number') return [];
			return [{ kind: 'bounced', providerMessageId: id, at, bounceType: 'hard' } as const];
		});
	},
};
// #endregion send-transport-webhook-module
