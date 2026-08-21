import type { ContactActivityEditorModule } from '../types';

export const emailClickedEditorModule: ContactActivityEditorModule<'email_clicked'> = {
	literal: 'email_clicked',
	displayConfig: {
		icon: 'lucide:mouse-pointer',
		label: 'shared.contactActivities.emailClicked.label',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.linkUrl) {
			return {
				key: 'shared.contactActivities.emailClicked.descriptionWithUrl',
				params: { url: metadata.linkUrl },
			};
		}
		return 'shared.contactActivities.emailClicked.description';
	},
};
