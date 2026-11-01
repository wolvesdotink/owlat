import type { ContactActivityEditorModule } from '../types';
import { EyeIcon } from '@coolicons/vue';

export const emailOpenedEditorModule: ContactActivityEditorModule<'email_opened'> = {
	literal: 'email_opened',
	displayConfig: {
		icon: EyeIcon,
		label: 'shared.contactActivities.emailOpened.label',
		color: 'text-success',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) {
			return {
				key: 'shared.contactActivities.emailOpened.descriptionWithSubject',
				params: { subject: metadata.emailSubject },
			};
		}
		return 'shared.contactActivities.emailOpened.description';
	},
};
