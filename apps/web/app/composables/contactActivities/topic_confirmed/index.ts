import type { ContactActivityEditorModule } from '../types';

export const topicConfirmedEditorModule: ContactActivityEditorModule<'topic_confirmed'> = {
	literal: 'topic_confirmed',
	displayConfig: {
		icon: 'lucide:check-circle',
		label: 'Topic Confirmed',
		color: 'text-success',
	},
	formatDescription(metadata) {
		if (metadata?.topicName) return `Confirmed subscription to ${metadata.topicName}`;
		return 'Confirmed topic subscription';
	},
};
