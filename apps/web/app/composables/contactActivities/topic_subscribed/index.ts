import type { ContactActivityEditorModule } from '../types';
import { ListPlusIcon } from '@coolicons/vue';

export const topicSubscribedEditorModule: ContactActivityEditorModule<'topic_subscribed'> = {
	literal: 'topic_subscribed',
	displayConfig: {
		icon: ListPlusIcon,
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
