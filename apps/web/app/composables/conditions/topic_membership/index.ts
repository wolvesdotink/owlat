import { defineAsyncComponent } from 'vue';
import type {
	ConditionEditorContext,
	ConditionEditorModule,
	ConditionOfKind,
	LocalizedText,
} from '../types';

type TopicMembershipCondition = ConditionOfKind<'topic_membership'>;

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.conditions.topic_membership';

export const TOPIC_OPERATORS: { value: TopicMembershipCondition['operator']; label: string }[] = [
	{ value: 'equals', label: `${K}.operators.equals` },
	{ value: 'not_equals', label: `${K}.operators.not_equals` },
];

export const topicMembershipEditorModule: ConditionEditorModule<'topic_membership'> = {
	kind: 'topic_membership',
	label: `${K}.label`,
	description: `${K}.description`,
	createDefault: () => ({
		kind: 'topic_membership',
		topicId: '',
		operator: 'equals',
	}),
	validateForSubmit(condition) {
		if (!condition.topicId) return `${K}.validation.topicRequired`;
		return null;
	},
	getDescription(condition, ctx: ConditionEditorContext): LocalizedText {
		if (!condition.topicId) return { key: `${K}.descriptions.empty` };
		const topic = ctx.topics.value.find((t) => t._id === condition.topicId);
		const subscribed = condition.operator !== 'not_equals';
		if (!topic) {
			return { key: subscribed ? `${K}.descriptions.anyTopic` : `${K}.descriptions.notAnyTopic` };
		}
		return {
			key: subscribed ? `${K}.descriptions.topic` : `${K}.descriptions.notTopic`,
			params: { topic: topic.name },
		};
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/topic_membership/Editor.vue')
	),
};
