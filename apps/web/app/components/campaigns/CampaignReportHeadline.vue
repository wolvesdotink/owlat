<script setup lang="ts">
/**
 * The report's lead sentence — "41% opened and 6.2% clicked — the best click
 * rate in your last 6 campaigns." — written by a template from this send's
 * numbers and the sends before it (`utils/marketingHeadline`). Renders nothing
 * until the campaign has delivered something to talk about.
 */
import {
	averageRates,
	ratesOf,
	reportHeadline,
	type EngagementCounts,
	type RatedCampaign,
} from '~/utils/marketingHeadline';
import { formatPercentage } from '~/utils/formatters';

/** Sends compared against, the current one included. */
const HISTORY_SIZE = 10;

interface ComparableSend extends EngagementCounts {
	id: string;
	sentAt: number;
}

const props = defineProps<{
	campaignId: string;
	sentAt: number | undefined;
	/** This send's own counters, as the report tiles show them. */
	current: EngagementCounts;
	/** Recent sent campaigns (`campaigns.analytics.getComparableSentCampaigns`). */
	comparables: readonly ComparableSend[] | undefined;
}>();

const { t } = useI18n();

const sentence = computed(() => {
	if (props.current.delivered <= 0) return null;
	const sentAt = props.sentAt;
	const earlier =
		sentAt === undefined
			? []
			: (props.comparables ?? [])
					.filter((c) => c.id !== props.campaignId && c.sentAt < sentAt)
					.sort((a, b) => a.sentAt - b.sentAt)
					.slice(-(HISTORY_SIZE - 1));
	const counts = [...earlier, props.current];
	const history: RatedCampaign[] = [
		...earlier.map((c) => ({ id: c.id, ...ratesOf(c) })),
		{ id: props.campaignId, ...ratesOf(props.current) },
	];
	const rates = ratesOf(props.current);
	const message = reportHeadline(props.campaignId, history, averageRates(counts), {
		open: formatPercentage(rates.openRate, rates.openRate >= 0.1 ? 0 : 1),
		click: formatPercentage(rates.clickRate, 1),
	});
	return t(message.key, message.params);
});
</script>

<template>
	<p v-if="sentence" class="font-display text-xl sm:text-2xl leading-snug text-text-primary">
		{{ sentence }}
	</p>
</template>
