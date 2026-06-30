import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const contactUpdatedTriggerEditorModule: TriggerEditorModule<'contact_updated'> = {
	kind: 'contact_updated',
	label: 'Contact Updated',
	description: "Trigger when a contact's property changes",
	icon: 'lucide:user-cog',
	color: 'lavender',
	requiresConfig: true,
	createDefault: () => ({ propertyKey: '' }),
	validateForSubmit(config) {
		if (!config.propertyKey) return 'Please select a property to watch';
		return null;
	},
	getSummary(config) {
		if (!config.propertyKey) return 'When a contact property changes';
		return `When ${config.propertyKey} changes`;
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/contact_updated/Editor.vue')
	),
};
