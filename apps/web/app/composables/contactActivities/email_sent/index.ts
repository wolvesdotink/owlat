import type { ContactActivityEditorModule } from '../types';

export const emailSentEditorModule: ContactActivityEditorModule<'email_sent'> = {
	literal: 'email_sent',
	displayConfig: {
		icon: 'lucide:send',
		label: 'shared.contactActivities.emailSent.label',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) {
			return {
				key: 'shared.contactActivities.emailSent.descriptionWithSubject',
				params: { subject: metadata.emailSubject },
			};
		}
		if (metadata?.emailType === 'transactional') {
			return 'shared.contactActivities.emailSent.descriptionTransactional';
		}
		return 'shared.contactActivities.emailSent.description';
	},
};
