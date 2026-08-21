import type { ContactActivityEditorModule } from '../types';

export const emailOpenedEditorModule: ContactActivityEditorModule<'email_opened'> = {
	literal: 'email_opened',
	displayConfig: {
		icon: 'lucide:eye',
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
