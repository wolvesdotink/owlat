import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const eventReceivedTriggerEditorModule: TriggerEditorModule<'event_received'> = {
	kind: 'event_received',
	label: 'shared.automations.triggers.eventReceived.label',
	description: 'shared.automations.triggers.eventReceived.description',
	icon: 'lucide:radio',
	color: 'warning',
	requiresConfig: true,
	createDefault: () => ({ eventName: '' }),
	validateForSubmit(config) {
		if (!config.eventName.trim())
			return 'shared.automations.triggers.eventReceived.eventNameRequired';
		return null;
	},
	getSummary(config) {
		if (!config.eventName.trim()) return 'shared.automations.triggers.eventReceived.summaryAny';
		return {
			key: 'shared.automations.triggers.eventReceived.summary',
			params: { name: config.eventName },
		};
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/event_received/Editor.vue')
	),
};
