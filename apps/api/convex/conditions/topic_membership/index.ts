import type { Id } from '../../_generated/dataModel';
import type { ConditionTypeModule, TopicMembershipCondition } from '../types';

export interface TopicMembershipLookup {
	/** Map of topicId → set of contactIds in the topic. */
	membersByTopic: Map<string, Set<string>>;
}

const VALID_OPERATORS = new Set(['equals', 'not_equals']);

/**
 * The distinct topics a condition set reads. ONE definition, because
 * `lookupReadsPerContact` is the multiplier the audience-scan document budget
 * is charged with: if it ever drifted from what `preloadLookupForContacts`
 * actually reads, the "bounded" scan would silently overrun the Convex
 * per-execution read limit.
 */
function distinctTopicIds(conditions: readonly TopicMembershipCondition[]): Set<string> {
	const topicIds = new Set<string>();
	for (const c of conditions) topicIds.add(c.topicId as string);
	return topicIds;
}

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

		const topicIds = distinctTopicIds(conditions);

		for (const topicId of topicIds) {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId as Id<'topics'>))
				.collect();
			lookup.membersByTopic.set(topicId, new Set(memberships.map((m) => m.contactId as string)));
		}

		return lookup;
	},
	async preloadLookupForContacts(ctx, conditions, contacts) {
		const lookup: TopicMembershipLookup = { membersByTopic: new Map() };

		const topicIds = distinctTopicIds(conditions);
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
						q.eq('contactId', contact._id).eq('topicId', topicId as Id<'topics'>)
					)
					.unique();
				if (membership) lookup.membersByTopic.get(topicId)!.add(contact._id as string);
			}
		}

		return lookup;
	},
	lookupReadsPerContact(conditions) {
		// One `by_contact_and_topic` point read per (contact × distinct topic).
		return distinctTopicIds(conditions).size;
	},
	lookupReadsPerBatch() {
		// No set-up: the topic ids are already in the conditions.
		return 0;
	},
	evaluate(condition, contact, lookup) {
		const members = lookup.membersByTopic.get(condition.topicId as string);
		const isMember = members ? members.has(contact._id as string) : false;
		return condition.operator === 'equals' ? isMember : !isMember;
	},
};
