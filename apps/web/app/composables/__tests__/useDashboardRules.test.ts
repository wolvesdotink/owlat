import { describe, it, expect } from 'vitest';
import {
	type EditableRule,
	type SavedRule,
	createEmptyRule,
	normalizeRules,
	toEditableRules,
} from '../useDashboardRules';

describe('useDashboardRules.normalizeRules', () => {
	const ruleWithCards = (over: Partial<EditableRule> = {}): EditableRule => ({
		...createEmptyRule(),
		cards: [{ type: 'verification_queue', size: 'large' }],
		...over,
	});

	it('drops rules with no cards (they would never render anything)', () => {
		const result = normalizeRules([createEmptyRule(5)]);
		expect(result).toEqual([]);
	});

	it('omits timeRange unless both ends are set', () => {
		expect(normalizeRules([ruleWithCards({ timeStart: '09:00', timeEnd: '' })])[0]!.condition.timeRange)
			.toBeUndefined();
		expect(normalizeRules([ruleWithCards({ timeStart: '', timeEnd: '17:00' })])[0]!.condition.timeRange)
			.toBeUndefined();
		expect(normalizeRules([ruleWithCards({ timeStart: '09:00', timeEnd: '17:00' })])[0]!.condition.timeRange)
			.toEqual({ start: '09:00', end: '17:00' });
	});

	it('includes dayOfWeek only when days are selected, and sorts them', () => {
		expect(normalizeRules([ruleWithCards({ dayOfWeek: [] })])[0]!.condition.dayOfWeek).toBeUndefined();
		expect(normalizeRules([ruleWithCards({ dayOfWeek: [5, 1, 3] })])[0]!.condition.dayOfWeek)
			.toEqual([1, 3, 5]);
	});

	it('includes role only when a specific role is chosen', () => {
		expect(normalizeRules([ruleWithCards({ role: '' })])[0]!.condition.role).toBeUndefined();
		expect(normalizeRules([ruleWithCards({ role: 'admin' })])[0]!.condition.role).toBe('admin');
	});

	it('produces a full payload matching the saveLayout shape', () => {
		const result = normalizeRules([
			ruleWithCards({
				timeStart: '06:00',
				timeEnd: '12:00',
				dayOfWeek: [1, 2, 3, 4, 5],
				role: 'owner',
				priority: 10,
				cards: [
					{ type: 'verification_queue', size: 'large' },
					{ type: 'queue_depth', size: 'small' },
				],
			}),
		]);
		expect(result).toEqual([
			{
				condition: {
					timeRange: { start: '06:00', end: '12:00' },
					dayOfWeek: [1, 2, 3, 4, 5],
					role: 'owner',
				},
				cards: [
					{ type: 'verification_queue', size: 'large' },
					{ type: 'queue_depth', size: 'small' },
				],
				priority: 10,
			},
		] satisfies SavedRule[]);
	});

	it('coerces a non-finite priority to 0', () => {
		expect(normalizeRules([ruleWithCards({ priority: Number.NaN })])[0]!.priority).toBe(0);
	});
});

describe('useDashboardRules.toEditableRules', () => {
	it('round-trips a saved rule back into the editor shape', () => {
		const saved: SavedRule[] = [
			{
				condition: {
					timeRange: { start: '09:00', end: '17:00' },
					dayOfWeek: [1, 2],
					role: 'editor',
				},
				cards: [{ type: 'campaign_performance', size: 'medium' }],
				priority: 3,
			},
		];
		expect(toEditableRules(saved)).toEqual([
			{
				timeStart: '09:00',
				timeEnd: '17:00',
				dayOfWeek: [1, 2],
				role: 'editor',
				cards: [{ type: 'campaign_performance', size: 'medium' }],
				priority: 3,
			},
		]);
	});

	it('defaults missing optional condition fields', () => {
		const saved: SavedRule[] = [
			{ condition: {}, cards: [{ type: 'agent_health', size: 'small' }], priority: 0 },
		];
		const editable = toEditableRules(saved)[0]!;
		expect(editable.timeStart).toBe('');
		expect(editable.timeEnd).toBe('');
		expect(editable.dayOfWeek).toEqual([]);
		expect(editable.role).toBe('');
	});

	it('returns an empty array for undefined input', () => {
		expect(toEditableRules(undefined)).toEqual([]);
	});
});
