import type {
	ConditionTypeModule,
	EmailActivityCondition,
} from '../types';

/**
 * No preloaded lookup. `email_activity` is evaluated directly off the
 * denormalized `contact.hasOpened` / `contact.hasClicked` flags maintained by
 * `contactActivities/writer.ts`.
 *
 * The old preload `.take(50000)`'d the unindexed `contactActivities` table into
 * an in-memory `Map<activityType, Set<contactId>>` on every segment evaluation.
 * That both blew the per-query read budget and — once the table passed 50k rows
 * — SILENTLY dropped contacts beyond the cap, making segment membership *wrong*,
 * not just slow. Reading the boolean off the already-loaded contact row is O(1)
 * and complete.
 */
export type EmailActivityLookup = Record<string, never>;

const VALID_FIELDS = new Set(['opened', 'clicked']);
const VALID_OPERATORS = new Set(['is_true', 'is_false']);

export const emailActivityConditionModule: ConditionTypeModule<
	'email_activity',
	EmailActivityLookup
> = {
	kind: 'email_activity',
	parseCondition(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('email_activity: condition must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (r['kind'] !== 'email_activity') {
			throw new Error('email_activity: kind must be "email_activity"');
		}
		if (typeof r['field'] !== 'string' || !VALID_FIELDS.has(r['field'])) {
			throw new Error(`email_activity: invalid field "${r['field'] as string}"`);
		}
		if (typeof r['operator'] !== 'string' || !VALID_OPERATORS.has(r['operator'])) {
			throw new Error(`email_activity: invalid operator "${r['operator'] as string}"`);
		}
		return {
			kind: 'email_activity',
			field: r['field'] as EmailActivityCondition['field'],
			operator: r['operator'] as EmailActivityCondition['operator'],
		};
	},
	async preloadLookup() {
		// No scan — evaluation reads the denormalized contact flags directly.
		return {};
	},
	async preloadLookupForContacts() {
		// No scan — evaluation reads the denormalized contact flags directly.
		return {};
	},
	evaluate(condition, contact) {
		const hasActivity =
			condition.field === 'opened'
				? contact.hasOpened === true
				: contact.hasClicked === true;
		return condition.operator === 'is_true' ? hasActivity : !hasActivity;
	},
};
