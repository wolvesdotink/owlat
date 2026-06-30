import type { ContactActivityEditorModule } from '../types';

export const inboundReceivedEditorModule: ContactActivityEditorModule<'inbound_received'> = {
	literal: 'inbound_received',
	displayConfig: {
		icon: 'lucide:mail',
		label: 'Inbound Received',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) return `Replied "${metadata.emailSubject}"`;
		return 'Replied to a thread';
	},
};
