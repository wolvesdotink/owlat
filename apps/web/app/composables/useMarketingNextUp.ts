/**
 * Band 3 of the Marketing overview — what needs a decision, what is queued,
 * and what is in progress — plus the header's "N to do" count.
 *
 * Reads only existing campaign queries: the bounded attention-candidate scan
 * (classified by the client util that is the source of truth for "needs you")
 * and two small status-filtered pages of the campaign list. "Going out today"
 * is left to the Scheduled panel rather than listed twice.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	CAMPAIGN_ATTENTION_DISPLAY,
	classifyCampaignAttention,
	type CampaignAttentionReason,
} from '~/utils/campaignAttention';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Scheduled campaigns read to sort client-side by send time. */
const SCHEDULED_WINDOW = 50;
const SCHEDULED_SHOWN = 5;
const DRAFTS_SHOWN = 3;

export interface NextUpRow {
	id: Id<'campaigns'>;
	name: string;
	href: string;
	/** Needs you: the attention reason. */
	reason?: CampaignAttentionReason;
	/** Message key for the reason chip (needs you only). */
	chipLabel?: string;
	/** Message key for the action verb (needs you only). */
	actionLabel?: string | null;
	scheduledAt?: number;
	updatedAt: number;
	/** A send within 24 hours that is waiting on review. */
	isUrgent: boolean;
}

function hrefFor(id: string, reason?: CampaignAttentionReason): string {
	// A/B results are folded into the report; review and resume live in the editor.
	return reason === 'ab_decision'
		? `/dashboard/campaigns/${id}/report`
		: `/dashboard/campaigns/${id}/edit`;
}

export function useMarketingNextUp() {
	const {
		data: candidates,
		isLoading: candidatesLoading,
		error: candidatesError,
	} = useOrganizationQuery(api.campaigns.organization.listAttentionCandidates);
	const {
		data: scheduledPage,
		isLoading: scheduledLoading,
		error: scheduledError,
	} = useOrganizationQuery(api.campaigns.campaigns.list, {
		status: 'scheduled',
		paginationOpts: { cursor: null, numItems: SCHEDULED_WINDOW },
	});
	const {
		data: draftsPage,
		isLoading: draftsLoading,
		error: draftsError,
	} = useOrganizationQuery(api.campaigns.campaigns.list, {
		status: 'draft',
		paginationOpts: { cursor: null, numItems: DRAFTS_SHOWN },
	});

	const needsYou = computed<NextUpRow[]>(() => {
		const now = Date.now();
		const rows: NextUpRow[] = [];
		for (const c of candidates.value ?? []) {
			const attention = classifyCampaignAttention({ ...c, now });
			if (!attention.reason || attention.reason === 'scheduled_today') continue;
			rows.push({
				id: c._id,
				name: c.name,
				href: hrefFor(c._id, attention.reason),
				reason: attention.reason,
				chipLabel: CAMPAIGN_ATTENTION_DISPLAY[attention.reason].chipLabel,
				actionLabel: attention.actionLabel,
				scheduledAt: c.scheduledAt,
				updatedAt: c.updatedAt,
				isUrgent:
					attention.reason === 'needs_review' &&
					c.scheduledAt !== undefined &&
					c.scheduledAt - now <= DAY_MS,
			});
		}
		return rows.sort(
			(a, b) => Number(b.isUrgent) - Number(a.isUrgent) || b.updatedAt - a.updatedAt
		);
	});

	const scheduledAll = computed<NextUpRow[]>(() =>
		(scheduledPage.value?.page ?? [])
			.map((c) => ({
				id: c._id,
				name: c.name,
				href: hrefFor(c._id),
				scheduledAt: c.scheduledAt,
				updatedAt: c.updatedAt,
				isUrgent: false,
			}))
			.sort(
				(a, b) =>
					(a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY)
			)
	);
	const scheduled = computed(() => scheduledAll.value.slice(0, SCHEDULED_SHOWN));

	const drafts = computed<NextUpRow[]>(() =>
		(draftsPage.value?.page ?? []).slice(0, DRAFTS_SHOWN).map((c) => ({
			id: c._id,
			name: c.name,
			href: hrefFor(c._id),
			updatedAt: c.updatedAt,
			isUrgent: false,
		}))
	);

	const todoCount = computed(() => needsYou.value.length + scheduledAll.value.length);
	const isUrgent = computed(() => needsYou.value.some((r) => r.isUrgent));
	const isLoading = computed(
		() =>
			(candidatesLoading.value && !candidates.value) ||
			(scheduledLoading.value && !scheduledPage.value) ||
			(draftsLoading.value && !draftsPage.value)
	);
	const error = computed(
		() => candidatesError.value ?? scheduledError.value ?? draftsError.value ?? null
	);

	return {
		needsYou,
		scheduled,
		scheduledTotal: computed(() => scheduledAll.value.length),
		drafts,
		todoCount,
		isUrgent,
		isLoading,
		error,
	};
}
