import type { ContactActivityEditorModule } from '../types';
import { ListMinusIcon } from '@coolicons/vue';

export const topicUnsubscribedEditorModule: ContactActivityEditorModule<'topic_unsubscribed'> = {
	literal: 'topic_unsubscribed',
	displayConfig: {
		icon: ListMinusIcon,
		label: 'shared.contactActivities.topicUnsubscribed.label',
		color: 'text-warning',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) {
			return {
				key: 'shared.contactActivities.topicUnsubscribed.descriptionWithTopic',
				params: { topic: metadata.topicName },
			};
		}
		return 'shared.contactActivities.topicUnsubscribed.description';
	},
};
