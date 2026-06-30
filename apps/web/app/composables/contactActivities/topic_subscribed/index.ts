import type { ContactActivityEditorModule } from '../types';

export const topicSubscribedEditorModule: ContactActivityEditorModule<'topic_subscribed'> = {
	literal: 'topic_subscribed',
	displayConfig: {
		icon: 'lucide:list-plus',
		label: 'Subscribed to Topic',
		color: 'text-brand',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) return `Subscribed to ${metadata.topicName}`;
		return 'Subscribed to topic';
	},
};
