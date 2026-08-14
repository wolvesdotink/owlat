import type { TriggerEditorModule } from '../types';

export const contactCreatedTriggerEditorModule: TriggerEditorModule<'contact_created'> = {
	kind: 'contact_created',
	label: 'shared.automations.triggers.contactCreated.label',
	description: 'shared.automations.triggers.contactCreated.description',
	icon: 'lucide:user-plus',
	color: 'lime',
	requiresConfig: false,
	createDefault: () => null,
	validateForSubmit: () => null,
	getSummary: () => 'shared.automations.triggers.contactCreated.summary',
	EditorComponent: null,
};
