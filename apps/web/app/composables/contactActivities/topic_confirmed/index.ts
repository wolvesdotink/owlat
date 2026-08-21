import type { ContactActivityEditorModule } from '../types';

export const topicConfirmedEditorModule: ContactActivityEditorModule<'topic_confirmed'> = {
	literal: 'topic_confirmed',
	displayConfig: {
		icon: 'lucide:check-circle',
		label: 'shared.contactActivities.topicConfirmed.label',
		color: 'text-success',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) {
			return {
				key: 'shared.contactActivities.topicConfirmed.descriptionWithTopic',
				params: { topic: metadata.topicName },
			};
		}
		return 'shared.contactActivities.topicConfirmed.description';
	},
};
