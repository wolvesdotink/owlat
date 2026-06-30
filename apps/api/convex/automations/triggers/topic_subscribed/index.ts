import type { Id } from '../../../_generated/dataModel';
import type {
	TopicSubscribedFireInput,
	TriggerModule,
} from '../types';

export interface TopicSubscribedConfig {
	topicId: string;
}

export const topicSubscribedTrigger: TriggerModule<
	'topic_subscribed',
	TopicSubscribedConfig,
	TopicSubscribedFireInput
> = {
	kind: 'topic_subscribed',
	parseConfig(raw) {
		if (raw && typeof raw === 'object' && 'topicId' in raw && typeof (raw as { topicId: unknown }).topicId === 'string') {
			return { topicId: (raw as { topicId: string }).topicId };
		}
		return null;
	},
	matches(input, config) {
		if (!config) return false;
		return config.topicId === (input.topicId as string);
	},
	buildTriggerData(input) {
		return { topicId: input.topicId as string };
	},
	async enrichForQuery(ctx, config) {
		if (!config?.topicId) return {};
		const topic = await ctx.db.get(config.topicId as Id<'topics'>);
		return { topic };
	},
};
