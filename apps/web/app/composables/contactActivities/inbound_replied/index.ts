import type { ContactActivityEditorModule } from '../types';
import { ReplyIcon } from '@coolicons/vue';

export const inboundRepliedEditorModule: ContactActivityEditorModule<'inbound_replied'> = {
	literal: 'inbound_replied',
	displayConfig: {
		icon: ReplyIcon,
		label: 'Inbound Replied',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) return `Auto-reply sent for "${metadata.emailSubject}"`;
		return 'Auto-reply sent';
	},
};
