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
	/** A message key; module scope has no `useI18n`, so the caller translates it. */
	label: string;
}

/** Message-key root for the labels; the row renders them with `t(…)`. */
const K = 'shared.useCampaignStatusBadge.status';

const STATUS_BADGES: Record<CampaignStatus, CampaignStatusBadge> = {
	draft: {
		color: 'bg-text-tertiary/10 text-text-tertiary',
		icon: PencilIcon,
		label: `${K}.draft`,
	},
	scheduled: { color: 'bg-brand/10 text-brand', icon: ClockIcon, label: `${K}.scheduled` },
	sending: { color: 'bg-warning/10 text-warning', icon: SpinnerIcon, label: `${K}.sending` },
	sent: { color: 'bg-success/10 text-success', icon: CircleCheckIcon, label: `${K}.sent` },
	cancelled: { color: 'bg-error/10 text-error', icon: CircleCloseIcon, label: `${K}.cancelled` },
	pending_review: {
		color: 'bg-warning/10 text-warning',
		icon: ShieldWarningIcon,
		label: `${K}.pendingReview`,
	},
};

export function useCampaignStatusBadge() {
	const getStatusBadge = (status: CampaignStatus): CampaignStatusBadge => STATUS_BADGES[status];

	return { getStatusBadge };
}
