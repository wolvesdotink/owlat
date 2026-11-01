import type { TriggerEditorModule } from '../types';
import { UserPlusCornerIcon } from '@coolicons/vue';

export const contactCreatedTriggerEditorModule: TriggerEditorModule<'contact_created'> = {
	kind: 'contact_created',
	label: 'shared.automations.triggers.contactCreated.label',
	description: 'shared.automations.triggers.contactCreated.description',
	icon: UserPlusCornerIcon,
	color: 'lime',
	requiresConfig: false,
	createDefault: () => null,
	validateForSubmit: () => null,
	getSummary: () => 'shared.automations.triggers.contactCreated.summary',
	EditorComponent: null,
};
