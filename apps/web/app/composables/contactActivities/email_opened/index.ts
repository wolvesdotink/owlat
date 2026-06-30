import type { ContactActivityEditorModule } from '../types';

export const emailOpenedEditorModule: ContactActivityEditorModule<'email_opened'> = {
	literal: 'email_opened',
	displayConfig: {
		icon: 'lucide:eye',
		label: 'Email Opened',
		color: 'text-success',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) return `Opened "${metadata.emailSubject}"`;
		return 'Opened email';
	},
};
