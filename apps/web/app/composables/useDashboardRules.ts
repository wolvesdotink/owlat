/**
 * Adaptive dashboard layout rules — pure editor-side helpers.
 *
 * The Convex backend (analytics/adaptiveDashboard) already evaluates rules by
 * time-of-day, day-of-week and role (highest `priority` first) in `getLayout`.
 * This module owns the *editing* shape: a blank rule, the day-of-week labels,
 * and the normalization that turns the editor's working copy into the exact
 * payload `saveLayout({ rules })` accepts. It is deliberately free of Vue/Convex
 * imports so the save-shape logic can be unit-tested in isolation.
 */

export type CardSize = 'small' | 'medium' | 'large';

export interface RuleCard {
	type: string;
	size: CardSize;
}

/** Role values mirror OrganizationRole in apps/api/convex/lib/sessionOrganization.ts. */
export type RuleRole = 'owner' | 'admin' | 'editor';

/**
 * The editor's working copy of a rule. Time fields are kept as plain strings so
 * empty inputs are easy to represent; `role` is the empty string for "any role".
 * `normalizeRules` collapses these back into the optional backend shape.
 */
export interface EditableRule {
	timeStart: string;
	timeEnd: string;
	dayOfWeek: number[];
	role: RuleRole | '';
	cards: RuleCard[];
	priority: number;
}

/** Persisted rule shape accepted by saveLayout (matches schema/dashboard.ts). */
export interface SavedRule {
	condition: {
		timeRange?: { start: string; end: string };
		dayOfWeek?: number[];
		role?: string;
	};
	cards: RuleCard[];
	priority: number;
}

/** 0 = Sunday … 6 = Saturday, matching `Date.getDay()` used by the backend. */
export const DAY_OF_WEEK_LABELS: { value: number; label: string }[] = [
	{ value: 1, label: 'Mon' },
	{ value: 2, label: 'Tue' },
	{ value: 3, label: 'Wed' },
	{ value: 4, label: 'Thu' },
	{ value: 5, label: 'Fri' },
	{ value: 6, label: 'Sat' },
	{ value: 0, label: 'Sun' },
];

export const ROLE_OPTIONS: { value: RuleRole | ''; label: string }[] = [
	{ value: '', label: 'Any role' },
	{ value: 'owner', label: 'Owner' },
	{ value: 'admin', label: 'Admin' },
	{ value: 'editor', label: 'Editor' },
];

/** A fresh, empty rule for the "Add rule" action. */
export function createEmptyRule(priority = 0): EditableRule {
	return {
		timeStart: '',
		timeEnd: '',
		dayOfWeek: [],
		role: '',
		cards: [],
		priority,
	};
}

/** Hydrate the editor's working copies from a persisted rules array. */
export function toEditableRules(rules: readonly SavedRule[] | undefined): EditableRule[] {
	if (!rules) return [];
	return rules.map((rule) => ({
		timeStart: rule.condition.timeRange?.start ?? '',
		timeEnd: rule.condition.timeRange?.end ?? '',
		dayOfWeek: [...(rule.condition.dayOfWeek ?? [])],
		role: (rule.condition.role as RuleRole | undefined) ?? '',
		cards: rule.cards.map((c) => ({ type: c.type, size: c.size })),
		priority: rule.priority,
	}));
}

/**
 * Collapse the editor's working copies into the payload `saveLayout` accepts:
 * - drop rules with no cards (an empty rule would never show anything),
 * - include `timeRange` only when both ends are set,
 * - include `dayOfWeek` only when at least one day is selected,
 * - include `role` only when a specific role is chosen.
 */
export function normalizeRules(editable: readonly EditableRule[]): SavedRule[] {
	const result: SavedRule[] = [];
	for (const rule of editable) {
		if (rule.cards.length === 0) continue;

		const condition: SavedRule['condition'] = {};
		if (rule.timeStart && rule.timeEnd) {
			condition.timeRange = { start: rule.timeStart, end: rule.timeEnd };
		}
		if (rule.dayOfWeek.length > 0) {
			condition.dayOfWeek = [...rule.dayOfWeek].sort((a, b) => a - b);
		}
		if (rule.role) {
			condition.role = rule.role;
		}

		result.push({
			condition,
			cards: rule.cards.map((c) => ({ type: c.type, size: c.size })),
			priority: Number.isFinite(rule.priority) ? rule.priority : 0,
		});
	}
	return result;
}
