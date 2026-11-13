<script setup lang="ts">
/**
 * Band 1 of the Marketing overview: the last (up to) three sends, newest first
 * and outlined. Each card leads with a template-written sentence and then its
 * open / click / unsubscribe rates against the average of the last ten sends.
 * A campaign still sending shows live counts and gets its sentence once done.
 */
import type { LatestCampaign, RecentCampaigns } from '~/utils/marketingOverviewTypes';
import { campaignHeadline, pointsDelta, ratesOf } from '~/utils/marketingHeadline';
import { formatNumber, formatPercentage, formatShortDate } from '~/utils/formatters';
import {
	ArrowDownRightIcon,
	ArrowUpRightIcon,
	MinusIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	campaigns: readonly LatestCampaign[];
	recent: RecentCampaigns;
}>();

const { t } = useI18n();

type MetricKey = 'openRate' | 'clickRate' | 'unsubscribeRate';

interface MetricRow {
	key: MetricKey;
	label: string;
	value: string;
	delta: string;
	/** 1 = better than average, -1 = worse, 0 = level. Picks the colour. */
	quality: -1 | 0 | 1;
	/** The numeric direction of the change. Picks the arrow. */
	direction: -1 | 0 | 1;
}

const METRICS: { key: MetricKey; labelKey: string; lowerIsBetter: boolean }[] = [
	{ key: 'openRate', labelKey: 'components.marketing.latest.opened', lowerIsBetter: false },
	{ key: 'clickRate', labelKey: 'components.marketing.latest.clicked', lowerIsBetter: false },
	{
		key: 'unsubscribeRate',
		labelKey: 'components.marketing.latest.unsubscribed',
		lowerIsBetter: true,
	},
];

function metricRows(campaign: LatestCampaign): MetricRow[] {
	const rates = ratesOf(campaign);
	const hasBaseline = props.recent.campaigns.length > 1;
	return METRICS.map((m) => {
		const delta = pointsDelta(rates[m.key], props.recent.average[m.key]);
		const quality = (m.lowerIsBetter ? -delta.sign : delta.sign) as -1 | 0 | 1;
		return {
			key: m.key,
			label: t(m.labelKey),
			// One precision for all three rates, so "0%" never sits beside "0.0%".
			value: formatPercentage(rates[m.key], 1),
			delta: hasBaseline ? t('components.marketing.latest.vsAverage', { points: delta.text }) : '',
			quality,
			// An unsubscribe rise is bad (red) but still points up, like its "+x pp".
			direction: delta.sign as -1 | 0 | 1,
		};
	});
}

function headline(campaign: LatestCampaign): string | null {
	if (campaign.isSending || campaign.delivered === 0) return null;
	const message = campaignHeadline(
		campaign.id,
		props.recent.campaigns.map((c) => ({ ...c, id: c.id as string })),
		props.recent.average
	);
	return message ? t(message.key, message.params) : null;
}

const cards = computed(() =>
	props.campaigns.map((campaign, index) => ({
		campaign,
		isNewest: index === 0,
		headline: headline(campaign),
		metrics: metricRows(campaign),
	}))
);

const qualityClass: Record<-1 | 0 | 1, string> = {
	1: 'text-success',
	0: 'text-text-tertiary',
	[-1]: 'text-error',
};
const qualityIcon: Record<-1 | 0 | 1, IconComponent> = {
	1: ArrowUpRightIcon,
	0: MinusIcon,
	[-1]: ArrowDownRightIcon,
};
</script>

<template>
	<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
		<NuxtLink
			v-for="card in cards"
			:key="card.campaign.id"
			:to="`/dashboard/campaigns/${card.campaign.id}/report`"
			:class="[
				'card p-5 flex flex-col gap-3 transition-colors duration-(--motion-fast) hover:border-border-default focus-visible:outline-2 focus-visible:outline-brand',
				card.isNewest ? 'border-brand' : '',
			]"
		>
			<div class="min-w-0">
				<p class="text-sm font-medium text-text-primary truncate" :title="card.campaign.name">
					{{ card.campaign.name }}
				</p>
				<p class="mt-0.5 text-xs text-text-tertiary tabular-nums">
					<template v-if="card.campaign.isSending">
						<span class="inline-flex items-center gap-1 text-info">
							<SpinnerIcon class="w-3 h-3" aria-hidden="true" />
							{{
								card.campaign.progress === undefined
									? t('components.marketing.latest.sending')
									: t('components.marketing.latest.sendingProgress', {
											percent: formatPercentage(card.campaign.progress, 0),
										})
							}}
						</span>
					</template>
					<template v-else>
						{{
							t('components.marketing.latest.sentLine', {
								date: formatShortDate(card.campaign.sentAt),
								delivered: formatNumber(card.campaign.delivered),
							})
						}}
					</template>
				</p>
			</div>

			<p v-if="card.headline" class="text-sm text-text-secondary leading-snug">
				{{ card.headline }}
			</p>

			<dl v-if="card.campaign.isSending" class="grid grid-cols-3 gap-2 mt-auto">
				<div>
					<dt class="text-2xs text-text-tertiary">
						{{ t('components.marketing.latest.delivered') }}
					</dt>
					<dd class="text-sm font-medium text-text-primary tabular-nums">
						{{ formatNumber(card.campaign.delivered) }}
					</dd>
				</div>
				<div>
					<dt class="text-2xs text-text-tertiary">
						{{ t('components.marketing.latest.opened') }}
					</dt>
					<dd class="text-sm font-medium text-text-primary tabular-nums">
						{{ formatNumber(card.campaign.opened) }}
					</dd>
				</div>
				<div>
					<dt class="text-2xs text-text-tertiary">
						{{ t('components.marketing.latest.clicked') }}
					</dt>
					<dd class="text-sm font-medium text-text-primary tabular-nums">
						{{ formatNumber(card.campaign.clicked) }}
					</dd>
				</div>
			</dl>

			<dl v-else class="grid grid-cols-3 gap-2 mt-auto">
				<div v-for="metric in card.metrics" :key="metric.key">
					<dt class="text-2xs text-text-tertiary">{{ metric.label }}</dt>
					<dd class="text-sm font-medium text-text-primary tabular-nums">{{ metric.value }}</dd>
					<dd
						v-if="metric.delta"
						:class="[
							'text-2xs tabular-nums inline-flex items-center gap-0.5',
							qualityClass[metric.quality],
						]"
					>
						<component :is="qualityIcon[metric.direction]" class="w-3 h-3" aria-hidden="true" />
						{{ metric.delta }}
					</dd>
				</div>
			</dl>
		</NuxtLink>
	</div>
</template>
