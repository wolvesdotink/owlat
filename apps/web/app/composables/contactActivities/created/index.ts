import type { ContactActivityEditorModule } from '../types';

export const createdEditorModule: ContactActivityEditorModule<'created'> = {
	literal: 'created',
	displayConfig: {
		icon: 'lucide:user-plus',
		label: 'Contact Created',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.source) return `Contact created via ${metadata.source}`;
		return 'Contact created';
	},
};
