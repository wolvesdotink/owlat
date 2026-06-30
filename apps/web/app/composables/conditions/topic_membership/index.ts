import { defineAsyncComponent } from 'vue';
import type { ConditionEditorContext, ConditionEditorModule, ConditionOfKind } from '../types';

type TopicMembershipCondition = ConditionOfKind<'topic_membership'>;

export const TOPIC_OPERATORS: { value: TopicMembershipCondition['operator']; label: string }[] = [
	{ value: 'equals', label: 'Is in topic' },
	{ value: 'not_equals', label: 'Is not in topic' },
];

export const topicMembershipEditorModule: ConditionEditorModule<'topic_membership'> = {
	kind: 'topic_membership',
	label: 'Topic Membership',
	description: 'Filter by topic membership',
	createDefault: () => ({
		kind: 'topic_membership',
		topicId: '',
		operator: 'equals',
	}),
	validateForSubmit(condition) {
		if (!condition.topicId) return 'Please select a topic';
		return null;
	},
	getDescription(condition, ctx: ConditionEditorContext) {
		if (!condition.topicId) return 'Select a topic';
		const topic = ctx.topics.value.find((t) => t._id === condition.topicId);
		const verb = condition.operator === 'not_equals' ? 'Is not subscribed to' : 'Is subscribed to';
		return topic ? `${verb} ${topic.name}` : `${verb} topic`;
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/topic_membership/Editor.vue')
	),
};
