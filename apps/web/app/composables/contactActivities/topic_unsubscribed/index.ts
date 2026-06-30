import type { ContactActivityEditorModule } from '../types';

export const topicUnsubscribedEditorModule: ContactActivityEditorModule<'topic_unsubscribed'> = {
	literal: 'topic_unsubscribed',
	displayConfig: {
		icon: 'lucide:list-minus',
		label: 'Unsubscribed from Topic',
		color: 'text-warning',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) return `Unsubscribed from ${metadata.topicName}`;
		return 'Unsubscribed from topic';
	},
};
