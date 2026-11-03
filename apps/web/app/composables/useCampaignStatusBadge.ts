/**
 * Single source of truth for campaign status badges.
 *
 * Both the campaigns overview and the "all campaigns" list render a
 * status pill (colour + icon + label) for a campaign. This composable
 * owns that map so the two screens cannot drift.
 */

/** The set of statuses a campaign record can actually have. */
import {
	CircleCheckIcon,
	CircleCloseIcon,
	ClockIcon,
	PencilIcon,
	ShieldWarningIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

export type CampaignStatus =
	| 'draft'
	| 'scheduled'
	| 'sending'
	| 'sent'
	| 'cancelled'
	| 'pending_review';

interface CampaignStatusBadge {
	color: string;
	icon: IconComponent;
	label: string;
}

const STATUS_BADGES: Record<CampaignStatus, CampaignStatusBadge> = {
	draft: { color: 'bg-text-tertiary/10 text-text-tertiary', icon: PencilIcon, label: 'Draft' },
	scheduled: { color: 'bg-brand/10 text-brand', icon: ClockIcon, label: 'Scheduled' },
	sending: { color: 'bg-warning/10 text-warning', icon: SpinnerIcon, label: 'Sending' },
	sent: { color: 'bg-success/10 text-success', icon: CircleCheckIcon, label: 'Sent' },
	cancelled: { color: 'bg-error/10 text-error', icon: CircleCloseIcon, label: 'Cancelled' },
	pending_review: {
		color: 'bg-warning/10 text-warning',
		icon: ShieldWarningIcon,
		label: 'Under Review',
	},
};

export function useCampaignStatusBadge() {
	const getStatusBadge = (status: CampaignStatus): CampaignStatusBadge => STATUS_BADGES[status];

	return { getStatusBadge };
}
