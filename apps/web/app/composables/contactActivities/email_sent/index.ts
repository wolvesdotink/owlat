import type { ContactActivityEditorModule } from '../types';

export const emailSentEditorModule: ContactActivityEditorModule<'email_sent'> = {
	literal: 'email_sent',
	displayConfig: {
		icon: 'lucide:send',
		label: 'Email Sent',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.emailSubject) return `Sent "${metadata.emailSubject}"`;
		if (metadata?.emailType === 'transactional') return 'Transactional email sent';
		return 'Email sent';
	},
};
