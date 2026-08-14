/**
 * Row derivation for the campaign command center.
 *
 * The page is a controller (pills, search, navigation, row actions); this
 * composable owns the step in between the two queries and the row component:
 * decorating a campaign with its attention roll-up, status badge and headline
 * rates (`~/utils/campaignCommandRow` holds the resulting type, which
 * `components/campaigns/CommandRow.vue` renders).
 */
import { CAMPAIGN_ATTENTION_DISPLAY, classifyCampaignAttention } from '~/utils/campaignAttention';
import type { CampaignRowFields, DecoratedRow } from '~/utils/campaignCommandRow';
import { useCampaignStatusBadge } from '~/composables/useCampaignStatusBadge';

/**
 * The two campaign sources plus the active query, as getters — the page holds
 * the refs, so reading them lazily keeps this composable independent of how
 * each one is fetched (paginated window vs. org-wide scan).
 */
export interface CampaignCommandRowSources {
	/** The paginated browse window (already status-filtered server-side). */
	rows: () => readonly CampaignRowFields[] | undefined;
	/** The bounded org-wide scan of campaigns that MIGHT need attention. */
	attentionCandidates: () => readonly CampaignRowFields[] | undefined;
	/** The debounced, trimmed search query. */
	search: () => string;
}

export function useCampaignCommandRows(sources: CampaignCommandRowSources) {
	const { getStatusBadge } = useCampaignStatusBadge();

	function rate(numer: number | undefined, denom: number | undefined): number | null {
		if (!denom || denom <= 0) return null;
		return ((numer ?? 0) / denom) * 100;
	}

	function decorate(campaign: CampaignRowFields): DecoratedRow {
		const attention = classifyCampaignAttention({
			status: campaign.status,
			scheduledAt: campaign.scheduledAt,
			isABTest: campaign.isABTest,
			abTestStatus: campaign.abTestStatus,
			abWinner: campaign.abWinner,
			contentBlockReason: campaign.contentBlockReason,
		});
		const display = attention.reason ? CAMPAIGN_ATTENTION_DISPLAY[attention.reason] : null;
		const openRate = rate(campaign.statsOpened, campaign.statsDelivered);
		const clickRate = rate(campaign.statsClicked, campaign.statsDelivered);
		// A/B campaigns carry two comparable sends (variant A = main stats,
		// variant B = abVariantB* fields) — a genuine two-point open-rate trend.
		const variantA = openRate;
		const variantB = rate(campaign.abVariantBOpened, campaign.abVariantBSent);
		const spark =
			campaign.isABTest === true && variantA != null && variantB != null
				? [variantA, variantB]
				: [];
		return {
			campaign,
			needsAttention: attention.needsAttention,
			reason: attention.reason,
			reasonChip: display ? { label: display.chipLabel, dot: display.dot } : null,
			statusBadge: getStatusBadge(campaign.status),
			actionLabel: attention.actionLabel,
			openRate,
			clickRate,
			variantA,
			variantB,
			spark,
		};
	}

	// Sort helper: attention first, then most-recent (updatedAt) — the design
	// brief's "surface what needs a decision, then the freshest work".
	function byAttentionThenRecency(a: DecoratedRow, b: DecoratedRow): number {
		if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
		return b.campaign.updatedAt - a.campaign.updatedAt;
	}

	// Attention rows come from the org-wide candidate scan, then the client
	// classifier (the source of truth) keeps only the ones genuinely waiting.
	// The browse pills search server-side, but the attention set is fetched
	// unsearched, so we apply the same debounced query here (case-insensitive
	// name/subject over the bounded candidate set) — otherwise typing on the
	// default pill would silently no-op and the "No results" empty state would
	// lie about a search that never ran.
	const attentionRows = computed<DecoratedRow[]>(() => {
		const q = sources.search().toLowerCase();
		return (sources.attentionCandidates() ?? [])
			.map(decorate)
			.filter((r) => r.needsAttention)
			.filter((r) => {
				if (!q) return true;
				const c = r.campaign;
				return c.name.toLowerCase().includes(q) || (c.subject?.toLowerCase().includes(q) ?? false);
			})
			.sort((a, b) => b.campaign.updatedAt - a.campaign.updatedAt);
	});

	const attentionCount = computed(() => attentionRows.value.length);

	// Browse rows come from the paginated (optionally status-filtered) window.
	const browseRows = computed<DecoratedRow[]>(() =>
		(sources.rows() ?? []).map(decorate).sort(byAttentionThenRecency)
	);

	return { attentionRows, attentionCount, browseRows };
}
