<script setup lang="ts">
/**
 * "Sending over 4 days · day 1 of 4 · 5 000 of 20 000" (deliverability plan
 * D14, P3-7).
 *
 * A warming deployment with no relay to overflow to sends a large campaign over
 * several days. That is a NORMAL, VISIBLE state — not an error and not a
 * surprise — so this is a neutral informational line, present from the moment
 * the send starts, in the same register as the rest of the campaign header. It
 * carries no warning colour, no icon of alarm and nothing to dismiss or fix,
 * and it is styled with the page's own utility vocabulary rather than a
 * one-off style island.
 *
 * It renders NOTHING for an ordinary same-day send, and nothing at all when
 * there is no walk in flight: absence of a plan is not a state to explain.
 */

import type { FunctionReturnType } from 'convex/server';
// TYPE-ONLY: the component needs the query's return shape, never the client.
import type { api } from '@owlat/api';

/**
 * The payload's shape comes from the query that produces it — one declaration,
 * so the component and the backend cannot drift apart.
 */
type SendPlanProgress = NonNullable<
	FunctionReturnType<typeof api.campaigns.sendPlanQueries.getCampaignSendPlan>
>;

const props = defineProps<{ progress: SendPlanProgress | null | undefined }>();

const { t, locale } = useI18n();

/** The neighbouring recipient count's idiom, so the two lines format alike. */
const formatCount = (value: number) => value.toLocaleString(locale.value);

/**
 * "over N days", or "over more than N days" when the plan is longer than we are
 * willing to enumerate. A truncated plan is never quoted as a finish date.
 */
const headline = computed(() => {
	const progress = props.progress;
	if (!progress) return null;
	return progress.isTruncated
		? t('components.campaigns.campaignSendPlanLine.headlineTruncated', {
				days: progress.totalDays,
			})
		: t('components.campaigns.campaignSendPlanLine.headline', { days: progress.totalDays });
});

const detail = computed(() => {
	const progress = props.progress;
	if (!progress) return null;
	const parts = [
		t('components.campaigns.campaignSendPlanLine.dayOf', {
			day: progress.day,
			totalDays: progress.totalDays,
		}),
	];
	// The denominator is only quoted when there is one, and it is quoted as the
	// FLOOR it is when the audience count stopped early: a walk whose audience we
	// could only bound says so rather than rounding a bound into a promise.
	if (progress.total > 0) {
		const total = progress.isTotalLowerBound
			? t('components.campaigns.campaignSendPlanLine.atLeast', {
					total: formatCount(progress.total),
				})
			: formatCount(progress.total);
		parts.push(
			t('components.campaigns.campaignSendPlanLine.enqueuedOfTotal', {
				enqueued: formatCount(progress.enqueued),
				total,
			})
		);
	} else if (progress.enqueued > 0) {
		parts.push(
			t('components.campaigns.campaignSendPlanLine.enqueuedSent', {
				enqueued: formatCount(progress.enqueued),
			})
		);
	}
	return parts.join(' · ');
});
</script>

<template>
	<p v-if="progress?.isMultiDay && headline" class="flex flex-wrap items-baseline gap-2 text-sm">
		<span class="font-medium text-text-secondary">{{ headline }}</span>
		<span class="text-text-tertiary tabular-nums">{{ detail }}</span>
	</p>
</template>
