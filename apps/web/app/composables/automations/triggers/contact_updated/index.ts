import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const contactUpdatedTriggerEditorModule: TriggerEditorModule<'contact_updated'> = {
	kind: 'contact_updated',
	label: 'shared.automations.triggers.contactUpdated.label',
	description: 'shared.automations.triggers.contactUpdated.description',
	icon: 'lucide:user-cog',
	color: 'lavender',
	requiresConfig: true,
	createDefault: () => ({ propertyKey: '' }),
	validateForSubmit(config) {
		if (!config.propertyKey) return 'shared.automations.triggers.contactUpdated.propertyRequired';
		return null;
	},
	getSummary(config) {
		if (!config.propertyKey) return 'shared.automations.triggers.contactUpdated.summaryAny';
		return {
			key: 'shared.automations.triggers.contactUpdated.summary',
			params: { property: config.propertyKey },
		};
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/contact_updated/Editor.vue')
	),
};
