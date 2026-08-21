import type { ContactActivityEditorModule } from '../types';

export const emailBouncedEditorModule: ContactActivityEditorModule<'email_bounced'> = {
	literal: 'email_bounced',
	displayConfig: {
		icon: 'lucide:alert-triangle',
		label: 'shared.contactActivities.emailBounced.label',
		color: 'text-error',
	},
	formatDescription(metadata) {
		const hard = metadata?.bounceType === 'hard';
		if (metadata?.errorMessage) {
			return {
				key: hard
					? 'shared.contactActivities.emailBounced.descriptionHardWithError'
					: 'shared.contactActivities.emailBounced.descriptionWithError',
				params: { error: metadata.errorMessage },
			};
		}
		return hard
			? 'shared.contactActivities.emailBounced.descriptionHard'
			: 'shared.contactActivities.emailBounced.description';
	},
};
