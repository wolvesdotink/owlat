/**
 * Single source of truth for campaign status badges.
 *
 * Both the campaigns overview and the "all campaigns" list render a
 * status pill (colour + icon + label) for a campaign. This composable
 * owns that map so the two screens cannot drift.
 */

/** The set of statuses a campaign record can actually have. */
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'pending_review';

/** Status values usable as a list filter, including the synthetic "all". */
export type CampaignStatusFilter = 'all' | CampaignStatus;

interface CampaignStatusBadge {
	color: string;
	icon: string;
	label: string;
}

const STATUS_BADGES: Record<CampaignStatus, CampaignStatusBadge> = {
	draft: { color: 'bg-text-tertiary/10 text-text-tertiary', icon: 'lucide:pencil', label: 'Draft' },
	scheduled: { color: 'bg-brand/10 text-brand', icon: 'lucide:clock', label: 'Scheduled' },
	sending: { color: 'bg-warning/10 text-warning', icon: 'lucide:loader-2', label: 'Sending' },
	sent: { color: 'bg-success/10 text-success', icon: 'lucide:check-circle', label: 'Sent' },
	cancelled: { color: 'bg-error/10 text-error', icon: 'lucide:x-circle', label: 'Cancelled' },
	pending_review: { color: 'bg-warning/10 text-warning', icon: 'lucide:shield-alert', label: 'Under Review' },
};

export function useCampaignStatusBadge() {
	const getStatusBadge = (status: CampaignStatus): CampaignStatusBadge => STATUS_BADGES[status];

	return { getStatusBadge };
}
