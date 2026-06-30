import type { TriggerEditorModule } from '../types';

export const contactCreatedTriggerEditorModule: TriggerEditorModule<'contact_created'> = {
	kind: 'contact_created',
	label: 'Contact Created',
	description: 'Trigger when a new contact is added to your audience',
	icon: 'lucide:user-plus',
	color: 'lime',
	requiresConfig: false,
	createDefault: () => null,
	validateForSubmit: () => null,
	getSummary: () => 'When a new contact is added',
	EditorComponent: null,
};
