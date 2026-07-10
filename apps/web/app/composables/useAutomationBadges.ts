/**
 * Single source of truth for automation status + trigger badges.
 *
 * The automations overview and the automation detail page both render a
 * status pill (colour + icon + label) and a trigger descriptor (icon +
 * label, plus text/background colours on the detail page). This composable
 * owns those maps so the two screens cannot drift.
 */

/** The set of statuses an automation record can actually have. */
export type AutomationStatus = 'draft' | 'active' | 'paused';

/** The set of triggers that can start an automation. */
export type AutomationTriggerType =
	| 'contact_created'
	| 'contact_updated'
	| 'event_received'
	| 'topic_subscribed';

interface AutomationStatusBadge {
	color: string;
	icon: string;
	label: string;
}

interface AutomationTriggerBadge {
	label: string;
	icon: string;
	color: string;
	bgColor: string;
}

const STATUS_BADGES: Record<AutomationStatus, AutomationStatusBadge> = {
	draft: { color: 'bg-text-tertiary/10 text-text-tertiary', icon: 'lucide:pencil', label: 'Draft' },
	active: { color: 'bg-success/10 text-success', icon: 'lucide:play', label: 'Active' },
	paused: { color: 'bg-warning/10 text-warning', icon: 'lucide:pause', label: 'Paused' },
};

const TRIGGER_BADGES: Record<AutomationTriggerType, AutomationTriggerBadge> = {
	contact_created: {
		label: 'Contact Created',
		icon: 'lucide:user-plus',
		color: 'text-brand',
		bgColor: 'bg-brand/10',
	},
	contact_updated: {
		label: 'Contact Updated',
		icon: 'lucide:user-cog',
		color: 'text-brand',
		bgColor: 'bg-brand/10',
	},
	event_received: {
		label: 'Event Received',
		icon: 'lucide:radio',
		color: 'text-warning',
		bgColor: 'bg-warning/10',
	},
	topic_subscribed: {
		label: 'Subscribed to Topic',
		icon: 'lucide:list-plus',
		color: 'text-success',
		bgColor: 'bg-success/10',
	},
};

export function useAutomationBadges() {
	const getStatusBadge = (status: AutomationStatus): AutomationStatusBadge => STATUS_BADGES[status];
	const getTriggerDisplay = (triggerType: AutomationTriggerType): AutomationTriggerBadge =>
		TRIGGER_BADGES[triggerType];

	return { getStatusBadge, getTriggerDisplay };
}
