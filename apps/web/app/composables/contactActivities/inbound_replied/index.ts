import type { ContactActivityEditorModule } from '../types';

export const inboundRepliedEditorModule: ContactActivityEditorModule<'inbound_replied'> = {
	literal: 'inbound_replied',
	displayConfig: {
		icon: 'lucide:reply',
		label: 'Inbound Replied',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) return `Auto-reply sent for "${metadata.emailSubject}"`;
		return 'Auto-reply sent';
	},
};
