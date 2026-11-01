/**
 * Shared presentation map for inbound-message (agent) categories.
 *
 * Single source of truth for the icon shown against a classified category,
 * consumed by the autonomy rule editor and the thread-detail composable.
 */

import {
	Building1Icon,
	BulbIcon,
	CreditCardIcon,
	HeadsetIcon,
	MailIcon,
	ShieldCloseIcon,
	TrendingUpIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

const AGENT_CATEGORY_ICONS: Record<string, IconComponent> = {
	support: HeadsetIcon,
	sales: TrendingUpIcon,
	billing: CreditCardIcon,
	feature_request: BulbIcon,
	complaint: TriangleWarningIcon,
	spam: ShieldCloseIcon,
	internal: Building1Icon,
	other: MailIcon,
};

export const categoryIcon = (category: string): IconComponent =>
	AGENT_CATEGORY_ICONS[category] ?? MailIcon;
