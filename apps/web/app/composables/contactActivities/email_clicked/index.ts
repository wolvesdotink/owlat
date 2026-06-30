import type { ContactActivityEditorModule } from '../types';

export const emailClickedEditorModule: ContactActivityEditorModule<'email_clicked'> = {
	literal: 'email_clicked',
	displayConfig: {
		icon: 'lucide:mouse-pointer',
		label: 'Link Clicked',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.linkUrl) return `Clicked ${metadata.linkUrl}`;
		return 'Clicked link in email';
	},
};
