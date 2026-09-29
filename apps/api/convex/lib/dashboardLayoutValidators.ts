import { v, type Infer } from 'convex/values';
import { widgetSizeValidator } from './convexValidators';

/**
 * Adaptive dashboard layout validators — the single declaration of a saved
 * layout's rule and card shapes. `schema/dashboard.ts` stores them and
 * `analytics/adaptiveDashboard.saveLayout` accepts them, so the table and the
 * mutation cannot drift apart. The web derives its `SavedRule` type from
 * `Doc<'dashboardLayouts'>`, which is built from these.
 */

/** One card slot: a card type (e.g. 'verification_queue') and its size. */
export const dashboardCardValidator = v.object({
	type: v.string(),
	size: widgetSizeValidator,
});

/**
 * When a rule applies. Every field is optional; an absent field matches
 * anything. `role` stays a plain string on the wire.
 */
export const dashboardRuleConditionValidator = v.object({
	timeRange: v.optional(
		v.object({
			start: v.string(), // e.g. '06:00'
			end: v.string(), // e.g. '12:00'
		})
	),
	dayOfWeek: v.optional(v.array(v.number())), // 0=Sun, 1=Mon, etc.
	role: v.optional(v.string()),
});

/** A context-driven layout rule; the highest matching `priority` wins. */
export const dashboardRuleValidator = v.object({
	condition: dashboardRuleConditionValidator,
	cards: v.array(dashboardCardValidator),
	priority: v.number(),
});

export type DashboardCard = Infer<typeof dashboardCardValidator>;
export type DashboardRuleCondition = Infer<typeof dashboardRuleConditionValidator>;
export type DashboardRule = Infer<typeof dashboardRuleValidator>;
