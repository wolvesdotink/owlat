import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const eventReceivedTriggerEditorModule: TriggerEditorModule<'event_received'> = {
	kind: 'event_received',
	label: 'Event Received',
	description: 'Trigger when a specific event is received from your app',
	icon: 'lucide:radio',
	color: 'warning',
	requiresConfig: true,
	createDefault: () => ({ eventName: '' }),
	validateForSubmit(config) {
		if (!config.eventName.trim()) return 'Please enter an event name';
		return null;
	},
	getSummary(config) {
		if (!config.eventName.trim()) return 'When an event is received';
		return `Event: ${config.eventName}`;
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/event_received/Editor.vue')
	),
};
