import type {
	EventReceivedFireInput,
	TriggerModule,
} from '../types';

export interface EventReceivedConfig {
	eventName: string;
}

export const eventReceivedTrigger: TriggerModule<
	'event_received',
	EventReceivedConfig,
	EventReceivedFireInput
> = {
	kind: 'event_received',
	parseConfig(raw) {
		if (raw && typeof raw === 'object' && 'eventName' in raw && typeof (raw as { eventName: unknown }).eventName === 'string') {
			return { eventName: (raw as { eventName: string }).eventName };
		}
		return null;
	},
	matches(input, config) {
		if (!config) return false;
		return config.eventName === input.eventName;
	},
	buildTriggerData(input) {
		const out: Record<string, string> = { eventName: input.eventName };
		if (input.eventProperties != null) out['eventProperties'] = input.eventProperties;
		return out;
	},
};
