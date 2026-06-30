import { defineAsyncComponent } from 'vue';
import type { DelayStepConfig, StepEditorModule } from '../types';

type Unit = DelayStepConfig['unit'];

function unitLabel(duration: number, unit: Unit): string {
	const isOne = duration === 1;
	if (unit === 'minutes') return isOne ? 'minute' : 'minutes';
	if (unit === 'hours') return isOne ? 'hour' : 'hours';
	if (unit === 'days') return isOne ? 'day' : 'days';
	return isOne ? 'week' : 'weeks';
}

export { unitLabel as delayUnitLabel };

export const delayStepEditorModule: StepEditorModule<'delay'> = {
	kind: 'delay',
	label: 'Wait/Delay',
	description: 'Wait before the next step',
	color: 'lavender',
	icon: 'lucide:clock',
	createDefault: () => ({ duration: 1, unit: 'days' }),
	parseConfig(raw): DelayStepConfig {
		const r = (raw ?? {}) as Record<string, unknown>;
		const unit = (r['unit'] as Unit) ?? 'days';
		const duration = typeof r['duration'] === 'number' ? r['duration'] : 1;
		return { duration, unit };
	},
	validateForActivation(config) {
		if (!config.duration || config.duration < 1) return 'Delay duration must be at least 1';
		return null;
	},
	getDescription(config) {
		if (!config.duration || !config.unit) return 'Configure delay';
		return `Wait ${config.duration} ${unitLabel(config.duration, config.unit)}`;
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/steps/delay/Editor.vue')
	),
};
