import type { ContactActivityEditorModule } from '../types';
import { TriangleWarningIcon } from '@coolicons/vue';

export const emailComplainedEditorModule: ContactActivityEditorModule<'email_complained'> = {
	literal: 'email_complained',
	displayConfig: {
		icon: TriangleWarningIcon,
		label: 'shared.contactActivities.emailComplained.label',
		color: 'text-error',
	},
	formatDescription() {
		return 'shared.contactActivities.emailComplained.description';
	},
};
