import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export type PropertyOperator =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'not_contains'
	| 'gt'
	| 'lt'
	| 'gte'
	| 'lte'
	| 'is_empty'
	| 'not_empty'
	| 'is_true'
	| 'is_false';

export type BooleanOperator = 'is_true' | 'is_false';

export type ContactPropertyCondition = {
	kind: 'contact_property';
	field: string;
	operator: PropertyOperator;
	value?: string | number | boolean;
};

export type EmailActivityCondition = {
	kind: 'email_activity';
	field: 'opened' | 'clicked';
	operator: BooleanOperator;
};

export type TopicMembershipCondition = {
	kind: 'topic_membership';
	topicId: string; // Conceptually Id<'topics'> but the segment filter validator emits a plain string.
	operator: 'equals' | 'not_equals';
};

export type Condition =
	| ContactPropertyCondition
	| EmailActivityCondition
	| TopicMembershipCondition;

export type ConditionKind = Condition['kind'];

export type ConditionOfKind<K extends ConditionKind> = Extract<Condition, { kind: K }>;

export interface ConditionTypeModule<K extends ConditionKind, Lookup> {
	readonly kind: K;
	parseCondition(raw: unknown): ConditionOfKind<K>;
	/**
	 * Population preload: resolve the lookup for evaluating against the WHOLE live
	 * contact population (the cron + preview paths stream every contact, so this
	 * front-loads whatever the kind needs in one collect). O(table) — use only
	 * where the caller already scans the whole population.
	 */
	preloadLookup(
		ctx: { db: DatabaseReader },
		conditions: ConditionOfKind<K>[]
	): Promise<Lookup>;
	/**
	 * Bounded preload: resolve the SAME lookup shape for just the given contacts
	 * (a single contact, or one page of a cursor-checkpointed walk) via per-contact
	 * point reads on a compound index — never a whole-column collect. Reads scale
	 * with `contacts.length`, so the single-contact (automation) and per-page
	 * (segment builder) paths stay bounded instead of front-loading the table.
	 */
	preloadLookupForContacts(
		ctx: { db: DatabaseReader },
		conditions: ConditionOfKind<K>[],
		contacts: readonly Doc<'contacts'>[]
	): Promise<Lookup>;
	evaluate(
		condition: ConditionOfKind<K>,
		contact: Doc<'contacts'>,
		lookup: Lookup
	): boolean;
}
