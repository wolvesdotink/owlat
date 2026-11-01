import type { ContactActivityEditorModule } from '../types';
import { MailIcon } from '@coolicons/vue';

export const inboundReceivedEditorModule: ContactActivityEditorModule<'inbound_received'> = {
	literal: 'inbound_received',
	displayConfig: {
		icon: MailIcon,
		label: 'shared.contactActivities.inboundReceived.label',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) {
			return {
				key: 'shared.contactActivities.inboundReceived.descriptionWithSubject',
				params: { subject: metadata.emailSubject },
			};
		}
		return 'shared.contactActivities.inboundReceived.description';
	},
};
