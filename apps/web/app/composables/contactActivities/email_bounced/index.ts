import type { ContactActivityEditorModule } from '../types';

export const emailBouncedEditorModule: ContactActivityEditorModule<'email_bounced'> = {
	literal: 'email_bounced',
	displayConfig: {
		icon: 'lucide:alert-triangle',
		label: 'Email Bounced',
		color: 'text-error',
	},
	formatDescription(metadata) {
		const kind = metadata?.bounceType === 'hard' ? 'Hard bounce' : 'Email bounced';
		if (metadata?.errorMessage) return `${kind}: ${metadata.errorMessage}`;
		return kind;
	},
};
