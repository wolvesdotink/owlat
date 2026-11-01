<script setup lang="ts">
// The campaign editor's IP warm-up card: progress, today's remaining capacity,
// and either the multi-day capacity plan or the send-time estimate.
import type { CampaignCapacitySchedulePlan } from '~/lib/campaignCapacityRefusal';
import { formatNumber } from '~/utils/formatters';
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { CircleCheckIcon, ClockIcon, FlameIcon } from '@coolicons/vue';

defineProps<{
	warming: {
		phase: string;
		ips?: ReadonlyArray<{ currentDay?: number }>;
		totalDailyCap: number;
		totalSentToday: number;
	};
	capacityPlan: CampaignCapacitySchedulePlan | null;
	/** The plan came from a refused send, so it can be dismissed. */
	capacityDismissible: boolean;
	sendEstimate: { days: number; message: string } | null;
	/** The exact eligible count, or `null` while it is only a lower bound. */
	audienceSize: number | null;
}>();

const emit = defineEmits<{ dismissCapacity: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-6">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox :icon="FlameIcon" size="lg" variant="brand" rounded="xl" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.campaigns.detail.edit.warmup.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.warmup.subtitle') }}
				</p>
			</div>
		</div>

		<!-- Graduated State -->
		<div
			v-if="warming.phase === 'graduated'"
			class="flex items-center gap-3 p-4 bg-success/10 border border-success/20 rounded-lg"
		>
			<CircleCheckIcon class="w-5 h-5 text-success shrink-0" />
			<div>
				<p class="text-sm font-medium text-success">
					{{ t('dashboard.campaigns.detail.edit.warmup.graduatedTitle') }}
				</p>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.warmup.graduatedDescription') }}
				</p>
			</div>
		</div>

		<!-- Warming State -->
		<div v-else class="space-y-4">
			<!-- Progress -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.campaigns.detail.edit.warmup.progress') }}
					</p>
					<p class="text-sm font-medium text-text-primary">
						{{
							t('dashboard.campaigns.detail.edit.warmup.dayOf', {
								day: warming.ips?.[0]?.currentDay ?? 1,
							})
						}}
					</p>
				</div>
				<div class="w-full h-2.5 bg-bg-surface rounded-full overflow-hidden">
					<div
						class="ui-meter-fill h-full bg-brand rounded-full transition-transform duration-(--motion-slow)"
						:style="meterFillStyle(Math.round(((warming.ips?.[0]?.currentDay ?? 1) / 30) * 100))"
					/>
				</div>
			</div>

			<!-- Today's Capacity -->
			<div class="flex items-center justify-between p-3 bg-bg-surface rounded-lg">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.warmup.remainingCapacity') }}
				</p>
				<p class="text-sm font-medium text-text-primary">
					{{
						t('dashboard.campaigns.detail.edit.warmup.remainingOfCap', {
							remaining: formatNumber(Math.max(0, warming.totalDailyCap - warming.totalSentToday)),
							cap: formatNumber(warming.totalDailyCap),
						})
					}}
				</p>
			</div>

			<!-- The multi-day schedule: previewed BEFORE the send, and re-rendered
			     from the refusal itself when pre-flight hands one back. Capacity is a
			     schedule, not a failure. -->
			<CampaignsCapacitySchedulePanel
				v-if="capacityPlan"
				:plan="capacityPlan"
				:dismissible="capacityDismissible"
				@dismiss="emit('dismissCapacity')"
			/>

			<!-- Send Estimate -->
			<div
				v-if="!capacityPlan && sendEstimate && audienceSize !== null && sendEstimate.days > 1"
				class="flex items-start gap-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
			>
				<ClockIcon class="w-5 h-5 text-warning shrink-0 mt-0.5" />
				<div>
					<p class="text-sm font-medium text-text-primary">
						{{
							t(
								'dashboard.campaigns.detail.edit.warmup.estimatedDays',
								{ days: sendEstimate.days },
								sendEstimate.days
							)
						}}
					</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{
							t('dashboard.campaigns.detail.edit.warmup.estimateDetail', {
								count: formatNumber(audienceSize ?? 0),
								message: sendEstimate.message,
							})
						}}
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
