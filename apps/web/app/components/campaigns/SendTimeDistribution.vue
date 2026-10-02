<script setup lang="ts">
/**
 * The predicted sends per hour for an "Optimized per contact" schedule, shown
 * before the campaign is scheduled. The backend plans the audience's first
 * page (`campaigns/sendTimeQueries.previewSendTimes`); for a larger audience
 * the bars are that sample's shares, and the copy says so.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { summarizeSendTimePreview } from '~/utils/sendTimePreview';

const props = defineProps<{
	campaignId: Id<'campaigns'>;
	startAt: number | null;
	windowHours: number;
	holdoutPercent: number;
}>();

const { t, locale } = useI18n();
const prefix = 'components.campaigns.sendTimeDistribution';

const {
	data: preview,
	error,
	isLoading,
	refetch,
} = useOrganizationQuery(api.campaigns.sendTimeQueries.previewSendTimes, () => {
	if (props.startAt === null) return undefined;
	const start = new Date(props.startAt);
	return {
		campaignId: props.campaignId,
		startAt: props.startAt,
		windowHours: props.windowHours,
		holdoutPercent: props.holdoutPercent,
		scheduledHour: start.getHours(),
		scheduledMinute: start.getMinutes(),
		// The bars are labelled in this zone, so they start on its hours.
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
	};
});

const hourFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { weekday: 'short', hour: 'numeric' })
);
const countFormat = computed(() => new Intl.NumberFormat(locale.value));
const percentFormat = computed(
	() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 })
);

const summary = computed(() => (preview.value ? summarizeSendTimePreview(preview.value) : null));

const bars = computed(() =>
	(preview.value?.hours ?? []).map((hour) => ({
		label: hourFormat.value.format(new Date(hour.at)),
		value: hour.count,
	}))
);

const labelEvery = computed(() => Math.max(1, Math.ceil(props.windowHours / 6)));

const formatShare = (count: number) =>
	summary.value && summary.value.total > 0
		? percentFormat.value.format(count / summary.value.total)
		: '0%';

const bestHourLabel = computed(() => {
	const hour = preview.value?.organizationBestHour;
	if (hour === null || hour === undefined) return null;
	const at = new Date();
	at.setHours(hour, 0, 0, 0);
	return new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }).format(at);
});
</script>

<template>
	<div data-testid="send-time-distribution">
		<div class="flex items-baseline justify-between gap-3 mb-2">
			<p class="text-sm font-medium text-text-primary">{{ t(`${prefix}.title`) }}</p>
			<p v-if="summary?.isSample" class="text-xs text-text-tertiary">
				{{ t(`${prefix}.sample`, { count: countFormat.format(summary.total) }) }}
			</p>
		</div>

		<p v-if="startAt === null" class="text-sm text-text-tertiary" data-state="no-start">
			{{ t(`${prefix}.pickStart`) }}
		</p>
		<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />
		<UiSkeleton v-else-if="isLoading || !preview" class="h-32 w-full" />
		<p v-else-if="summary?.total === 0" class="text-sm text-text-tertiary" data-state="empty">
			{{ t(`${prefix}.noRecipients`) }}
		</p>
		<template v-else-if="summary">
			<UiBars
				:data="bars"
				:height="112"
				:label-every="labelEvery"
				:aria-label="t(`${prefix}.chartLabel`)"
				:format-value="(value: number) => t(`${prefix}.sends`, { count: value }, value)"
			/>
			<ul class="mt-3 space-y-1 text-xs text-text-secondary" data-part="sources">
				<li v-if="preview!.sources.contact > 0">
					{{
						t(`${prefix}.sources.contact`, {
							share: formatShare(preview!.sources.contact),
						})
					}}
				</li>
				<li v-if="preview!.sources.organization > 0">
					{{
						t(`${prefix}.sources.organization`, {
							share: formatShare(preview!.sources.organization),
							time: bestHourLabel ?? '',
						})
					}}
				</li>
				<li v-if="preview!.sources.start > 0">
					{{ t(`${prefix}.sources.start`, { share: formatShare(preview!.sources.start) }) }}
				</li>
				<li v-if="preview!.sources.holdout > 0">
					{{ t(`${prefix}.sources.holdout`, { share: formatShare(preview!.sources.holdout) }) }}
				</li>
			</ul>
			<p
				v-if="summary.hasNoHistory"
				class="mt-2 text-xs text-text-tertiary"
				data-state="no-history"
			>
				{{ t(`${prefix}.noHistory`) }}
			</p>
		</template>
	</div>
</template>
