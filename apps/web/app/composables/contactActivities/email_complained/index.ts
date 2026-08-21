import type { ContactActivityEditorModule } from '../types';

export const emailComplainedEditorModule: ContactActivityEditorModule<'email_complained'> = {
	literal: 'email_complained',
	displayConfig: {
		icon: 'lucide:alert-triangle',
		label: 'shared.contactActivities.emailComplained.label',
		color: 'text-error',
	},
	formatDescription() {
		return 'shared.contactActivities.emailComplained.description';
	},
};
