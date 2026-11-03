/**
 * Single source of truth for automation status + trigger badges.
 *
 * The automations overview and the automation detail page both render a
 * status pill (colour + icon + label) and a trigger descriptor (icon +
 * label, plus text/background colours on the detail page). This composable
 * owns those maps so the two screens cannot drift.
 */

/** The set of statuses an automation record can actually have. */
import {
	BroadcastIcon,
	ListPlusIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	UserPlusCornerIcon,
	UserSettingsCornerIcon,
	type IconComponent,
} from '@coolicons/vue';

export type AutomationStatus = 'draft' | 'active' | 'paused';

/** The set of triggers that can start an automation. */
export type AutomationTriggerType =
	| 'contact_created'
	| 'contact_updated'
	| 'event_received'
	| 'topic_subscribed';

/**
 * Badge copy travels as a message KEY: these maps are module-scope definitions,
 * so they cannot call `useI18n`. The screens that render a badge translate it
 * (`t(badge.label)`).
 */
interface AutomationStatusBadge {
	color: string;
	icon: IconComponent;
	/** A message key. */
	label: string;
}

interface AutomationTriggerBadge {
	/** A message key. */
	label: string;
	icon: IconComponent;
	color: string;
	bgColor: string;
}

const STATUS_BADGES: Record<AutomationStatus, AutomationStatusBadge> = {
	draft: {
		color: 'bg-text-tertiary/10 text-text-tertiary',
		icon: PencilIcon,
		label: 'shared.useAutomationBadges.status.draft',
	},
	active: {
		color: 'bg-success/10 text-success',
		icon: PlayIcon,
		label: 'shared.useAutomationBadges.status.active',
	},
	paused: {
		color: 'bg-warning/10 text-warning',
		icon: PauseIcon,
		label: 'shared.useAutomationBadges.status.paused',
	},
};

const TRIGGER_BADGES: Record<AutomationTriggerType, AutomationTriggerBadge> = {
	contact_created: {
		label: 'shared.useAutomationBadges.triggers.contactCreated',
		icon: UserPlusCornerIcon,
		color: 'text-brand',
		bgColor: 'bg-brand/10',
	},
	contact_updated: {
		label: 'shared.useAutomationBadges.triggers.contactUpdated',
		icon: UserSettingsCornerIcon,
		color: 'text-brand',
		bgColor: 'bg-brand/10',
	},
	event_received: {
		label: 'shared.useAutomationBadges.triggers.eventReceived',
		icon: BroadcastIcon,
		color: 'text-warning',
		bgColor: 'bg-warning/10',
	},
	topic_subscribed: {
		label: 'shared.useAutomationBadges.triggers.topicSubscribed',
		icon: ListPlusIcon,
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
