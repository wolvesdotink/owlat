import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const topicSubscribedTriggerEditorModule: TriggerEditorModule<'topic_subscribed'> = {
	kind: 'topic_subscribed',
	label: 'Subscribed to Topic',
	description: 'Trigger when a contact subscribes to a topic',
	icon: 'lucide:list-plus',
	color: 'success',
	requiresConfig: true,
	createDefault: () => ({ topicId: '' }),
	validateForSubmit(config) {
		if (!config.topicId) return 'Please select a topic';
		return null;
	},
	getSummary(config, ctx) {
		if (!config.topicId) return 'When subscribed to a topic';
		const topic = ctx.topics.value.find((t) => t._id === config.topicId);
		return topic ? `Topic: ${topic.name}` : 'Topic: (unknown)';
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/topic_subscribed/Editor.vue')
	),
};
