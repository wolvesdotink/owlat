import { computed } from 'vue';
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';
import { formatNumber } from '~/utils/formatters';
import { exactEligibleCount, isLowerBoundCount } from '~/composables/useRecipientCount';
import type { useCampaignForm } from '~/composables/useCampaignForm';

type CampaignForm = ReturnType<typeof useCampaignForm>;

/**
 * What the campaign editor shows about sending capacity: the warm-up state, the
 * exact audience size, the send estimate, the capacity plan and today's
 * headroom. Subscriptions live as long as the calling page.
 */
export function useCampaignSendCapacity(
	options: Pick<
		CampaignForm,
		'audience' | 'audienceCount' | 'fromEmail' | 'scheduledStartAt' | 'capacitySchedule'
	>
) {
	const { audience, audienceCount, fromEmail, scheduledStartAt, capacitySchedule } = options;

	// IP Warmup state
	const { data: warmingOverview } = useOrganizationQuery(
		api.analytics.reputationQueries.getSendingOverview
	);

	// The eligible count only when it is exact: a big audience's readout is
	// a lower bound until its background count completes, and the send estimate
	// and readiness note must not plan against an understated size. The label
	// keeps the "N+" reading for copy that just names the number.
	const exactAudienceSize = computed(() => exactEligibleCount(audienceCount.value));
	const audienceCountLabel = computed(
		() =>
			`${formatNumber(audienceCount.value?.eligible ?? 0)}${isLowerBoundCount(audienceCount.value) ? '+' : ''}`
	);

	// Warming-aware "this campaign will take ~N days" estimate. The projection
	// algorithm lives once on the backend (getCampaignSendEstimate); we just feed
	// it the exact eligible recipient count and reshape estimatedDays → days for
	// the template. Skips until an exact count is known (factory returns undefined).
	const { data: sendEstimateRaw } = useOrganizationQuery(
		api.analytics.reputationQueries.getCampaignSendEstimate,
		() => {
			const count = exactAudienceSize.value;
			if (count === null) return undefined;
			return { recipientCount: count };
		}
	);

	const sendEstimate = computed(() => {
		if (!sendEstimateRaw.value) return null;
		return {
			days: sendEstimateRaw.value.estimatedDays,
			isFullyWarmed: sendEstimateRaw.value.isFullyWarmed,
			message: sendEstimateRaw.value.message,
		};
	});

	// The BINDING capacity plan, previewed BEFORE the operator presses send.
	//
	// Same assessment pre-flight makes, so the operator sees "Sending over N days" as
	// a first-class choice rather than discovering it as a refusal (a multi-day send
	// is a normal, visible state for a warming deployment, never a surprise). Skips
	// until there is an audience and a valid From address; `fromEmail` is what
	// decides whether warm-up overflow to a verified relay absorbs the tail, so
	// previewing without it would answer a different question than the gate.
	const { data: capacityPreviewRaw } = useOrganizationQuery(
		api.campaigns.capacityPreflight.getCampaignCapacityPlan,
		() => {
			const selected = audience.value;
			const from = fromEmail.value.trim();
			if (!selected || !isValidEmail(from)) return undefined;
			// Anchor on the chosen start when there is one: a campaign scheduled for
			// next week is judged against the capacity it will have then.
			const startsAt = scheduledStartAt.value;
			return { audience: selected, fromEmail: from, ...(startsAt !== null ? { startsAt } : {}) };
		}
	);

	// TODAY'S HEADROOM, beside the send buttons. The capacity plan above answers
	// "how long will this take"; this answers the question the operator asks first —
	// how much can go out right now, and when does that grow. Same paced projection
	// as the gate, so the two lines cannot disagree. `fromEmail` is passed whenever
	// it is valid (it decides whether warm-up overflow absorbs the tail); without
	// one the backend answers conservatively rather than skipping, so the line is
	// still there while the address is being typed.
	const { data: sendingReadiness } = useOrganizationQuery(
		api.campaigns.sendingReadiness.getSendingReadiness,
		() => {
			const from = fromEmail.value.trim();
			return isValidEmail(from) ? { fromEmail: from } : {};
		}
	);

	/**
	 * The schedule to render: the one pre-flight actually refused with, else the
	 * preview. The refusal wins — it is the authoritative answer for the send the
	 * operator just attempted.
	 */
	const shownCapacityPlan = computed(() => {
		if (capacitySchedule.value) return capacitySchedule.value;
		const preview = capacityPreviewRaw.value;
		return preview && !preview.fits ? preview.schedule : null;
	});

	return {
		warmingOverview,
		exactAudienceSize,
		audienceCountLabel,
		sendEstimate,
		sendingReadiness,
		shownCapacityPlan,
	};
}
