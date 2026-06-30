/**
 * Shared presentation map for inbound-message (agent) categories.
 *
 * Single source of truth for the icon shown against a classified category,
 * consumed by the autonomy rule editor and the thread-detail composable.
 */

export const AGENT_CATEGORY_ICONS: Record<string, string> = {
	support: 'lucide:life-buoy',
	sales: 'lucide:trending-up',
	billing: 'lucide:credit-card',
	feature_request: 'lucide:lightbulb',
	complaint: 'lucide:alert-triangle',
	spam: 'lucide:shield-x',
	internal: 'lucide:building',
	other: 'lucide:mail',
};

export const categoryIcon = (category: string): string => AGENT_CATEGORY_ICONS[category] ?? 'lucide:mail';
