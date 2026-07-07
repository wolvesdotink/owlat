import type { Id } from '../../_generated/dataModel';
import type {
	ConditionTypeModule,
	TopicMembershipCondition,
} from '../types';

export interface TopicMembershipLookup {
	/** Map of topicId → set of contactIds in the topic. */
	membersByTopic: Map<string, Set<string>>;
}

const VALID_OPERATORS = new Set(['equals', 'not_equals']);

export const topicMembershipConditionModule: ConditionTypeModule<
	'topic_membership',
	TopicMembershipLookup
> = {
	kind: 'topic_membership',
	parseCondition(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('topic_membership: condition must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (r['kind'] !== 'topic_membership') {
			throw new Error('topic_membership: kind must be "topic_membership"');
		}
		if (typeof r['topicId'] !== 'string' || r['topicId'].length === 0) {
			throw new Error('topic_membership: topicId must be a non-empty string');
		}
		if (typeof r['operator'] !== 'string' || !VALID_OPERATORS.has(r['operator'])) {
			throw new Error(`topic_membership: invalid operator "${r['operator'] as string}"`);
		}
		return {
			kind: 'topic_membership',
			topicId: r['topicId'] as string,
			operator: r['operator'] as TopicMembershipCondition['operator'],
		};
	},
	async preloadLookup(ctx, conditions) {
		const lookup: TopicMembershipLookup = { membersByTopic: new Map() };

		const topicIds = new Set<string>();
		for (const c of conditions) topicIds.add(c.topicId as string);

		// Streamed via `for await` so each topic's member set builds without
		// materializing an unbounded `.collect()`; this whole-base preload feeds
		// one Convex-limited segment scan (the paginated match paths use
		// `preloadLookupForContacts` and point-reads instead).
		for (const topicId of topicIds) {
			const members = new Set<string>();
			for await (const m of ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId as Id<'topics'>))) {
				members.add(m.contactId as string);
			}
			lookup.membersByTopic.set(topicId, members);
		}

		return lookup;
	},
	async preloadLookupForContacts(ctx, conditions, contacts) {
		const lookup: TopicMembershipLookup = { membersByTopic: new Map() };

		const topicIds = new Set<string>();
		for (const c of conditions) topicIds.add(c.topicId as string);
		for (const topicId of topicIds) lookup.membersByTopic.set(topicId, new Set());

		// Point-read each (contact, topic) membership via the by_contact_and_topic
		// index — reads scale with `contacts.length × topics`, never the whole
		// topic membership junction. Only members of the given contacts land in the
		// set; non-members are absent, which `evaluate` reads as "not a member".
		for (const contact of contacts) {
			for (const topicId of topicIds) {
				const membership = await ctx.db
					.query('contactTopics')
					.withIndex('by_contact_and_topic', (q) =>
						q.eq('contactId', contact._id).eq('topicId', topicId as Id<'topics'>),
					)
					.unique();
				if (membership) lookup.membersByTopic.get(topicId)!.add(contact._id as string);
			}
		}

		return lookup;
	},
	evaluate(condition, contact, lookup) {
		const members = lookup.membersByTopic.get(condition.topicId as string);
		const isMember = members ? members.has(contact._id as string) : false;
		return condition.operator === 'equals' ? isMember : !isMember;
	},
};
