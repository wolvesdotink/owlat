import type { ContactActivityEditorModule } from '../types';
import { UserPlusCornerIcon } from '@coolicons/vue';

export const createdEditorModule: ContactActivityEditorModule<'created'> = {
	literal: 'created',
	displayConfig: {
		icon: UserPlusCornerIcon,
		label: 'shared.contactActivities.created.label',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.source) {
			return {
				key: 'shared.contactActivities.created.descriptionWithSource',
				params: { source: metadata.source },
			};
		}
		return 'shared.contactActivities.created.description';
	},
};
