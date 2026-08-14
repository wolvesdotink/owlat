import type { ContactActivityEditorModule } from '../types';

export const topicSubscribedEditorModule: ContactActivityEditorModule<'topic_subscribed'> = {
	literal: 'topic_subscribed',
	displayConfig: {
		icon: 'lucide:list-plus',
		label: 'shared.contactActivities.topicSubscribed.label',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) {
			return {
				key: 'shared.contactActivities.topicSubscribed.descriptionWithTopic',
				params: { topic: metadata.topicName },
			};
		}
		return 'shared.contactActivities.topicSubscribed.description';
	},
};
