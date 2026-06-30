import type { ContactActivityEditorModule } from '../types';

export const emailComplainedEditorModule: ContactActivityEditorModule<'email_complained'> = {
	literal: 'email_complained',
	displayConfig: {
		icon: 'lucide:alert-triangle',
		label: 'Spam Complaint',
		color: 'text-error',
	},
	formatDescription() {
		return 'Marked email as spam';
	},
};
