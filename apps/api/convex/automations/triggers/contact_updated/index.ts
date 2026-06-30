import type {
	ContactUpdatedFireInput,
	TriggerModule,
} from '../types';

export interface ContactUpdatedConfig {
	propertyKey: string;
}

export const contactUpdatedTrigger: TriggerModule<
	'contact_updated',
	ContactUpdatedConfig,
	ContactUpdatedFireInput
> = {
	kind: 'contact_updated',
	parseConfig(raw) {
		if (raw && typeof raw === 'object' && 'propertyKey' in raw && typeof (raw as { propertyKey: unknown }).propertyKey === 'string') {
			return { propertyKey: (raw as { propertyKey: string }).propertyKey };
		}
		return null;
	},
	matches(input, config) {
		if (!config) return false;
		return input.changedProperties.includes(config.propertyKey);
	},
	buildTriggerData(_input, config) {
		return config
			? ({ propertyKey: config.propertyKey } as const)
			: ({} as Record<string, string>);
	},
};
