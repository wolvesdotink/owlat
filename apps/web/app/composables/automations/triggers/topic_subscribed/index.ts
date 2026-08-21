import { defineAsyncComponent } from 'vue';
import type { TriggerEditorModule } from '../types';

export const topicSubscribedTriggerEditorModule: TriggerEditorModule<'topic_subscribed'> = {
	kind: 'topic_subscribed',
	label: 'shared.automations.triggers.topicSubscribed.label',
	description: 'shared.automations.triggers.topicSubscribed.description',
	icon: 'lucide:list-plus',
	color: 'success',
	requiresConfig: true,
	createDefault: () => ({ topicId: '' }),
	validateForSubmit(config) {
		if (!config.topicId) return 'shared.automations.triggers.topicSubscribed.topicRequired';
		return null;
	},
	getSummary(config, ctx) {
		if (!config.topicId) return 'shared.automations.triggers.topicSubscribed.summaryAny';
		const topic = ctx.topics.value.find((t) => t._id === config.topicId);
		// The topic name is member-authored data, so it travels as an
		// interpolation rather than as a key of its own.
		return topic
			? { key: 'shared.automations.triggers.topicSubscribed.summary', params: { name: topic.name } }
			: 'shared.automations.triggers.topicSubscribed.summaryUnknown';
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/triggers/topic_subscribed/Editor.vue')
	),
};
