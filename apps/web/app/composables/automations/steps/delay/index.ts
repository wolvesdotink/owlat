import { defineAsyncComponent } from 'vue';
import type { DelayStepConfig, StepEditorModule } from '../types';

type Unit = DelayStepConfig['unit'];

/**
 * The message key for a unit word, singular or plural. Registry modules cannot
 * call `useI18n`, and the renderer resolves a key with `t(key)` rather than
 * `t(key, count)`, so each unit carries its own `one`/`other` key.
 */
function unitLabel(duration: number, unit: Unit): string {
	return `shared.automations.steps.delay.units.${unit}.${duration === 1 ? 'one' : 'other'}`;
}

export { unitLabel as delayUnitLabel };

export const delayStepEditorModule: StepEditorModule<'delay'> = {
	kind: 'delay',
	label: 'shared.automations.steps.delay.label',
	description: 'shared.automations.steps.delay.description',
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
		if (!config.duration || config.duration < 1)
			return 'shared.automations.steps.delay.durationTooShort';
		return null;
	},
	getDescription(config) {
		if (!config.duration || !config.unit) return 'shared.automations.steps.delay.configure';
		const plural = config.duration === 1 ? 'one' : 'other';
		return {
			key: `shared.automations.steps.delay.wait.${config.unit}.${plural}`,
			params: { count: config.duration },
		};
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/steps/delay/Editor.vue')
	),
};
