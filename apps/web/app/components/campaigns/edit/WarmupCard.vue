<script setup lang="ts">
// The campaign editor's IP warm-up card: progress, today's remaining capacity,
// and either the multi-day capacity plan or the send-time estimate. A halted
// warm-up reads as halted, not as progress.
import type { CampaignCapacitySchedulePlan } from '~/lib/campaignCapacityRefusal';
import type { SendingReadiness } from '~/lib/sendReadiness';
import { WARMUP_DAYS, warmupDay } from '~/utils/deliveryHub';
import { formatNumber } from '~/utils/formatters';
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { CircleCheckIcon, CircleWarningIcon, ClockIcon, FlameIcon } from '@coolicons/vue';

const props = defineProps<{
	warming: {
		phase: string;
		ips?: ReadonlyArray<{ currentDay?: number }>;
	};
	/**
	 * Today's headroom from `getSendingReadiness`: the paced projection the send
	 * gate meters against, so this card and the readiness note beside the send
	 * buttons quote the same number.
	 */
	readiness: SendingReadiness | null | undefined;
	capacityPlan: CampaignCapacitySchedulePlan | null;
	/** The plan came from a refused send, so it can be dismissed. */
	capacityDismissible: boolean;
	/** `isTruncated`: the projection stopped before reaching everyone, so `days` is a floor. */
	sendEstimate: { days: number; isTruncated: boolean } | null;
	/** The exact eligible count, or `null` while it is only a lower bound. */
	audienceSize: number | null;
}>();

const emit = defineEmits<{ dismissCapacity: [] }>();

const { t } = useI18n();
const { isAdmin } = usePermissions();

// `plateau` is the MTA's critical halt: sending is held until it recovers.
const isHalted = computed(() => props.warming.phase === 'plateau');
const day = computed(() => warmupDay(props.warming.ips ?? []));
const remainingToday = computed(() =>
	props.readiness?.capped === true ? props.readiness.today : null
);
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

		<div v-else class="space-y-4">
			<!-- Halted: the delivery hub's own sentence, and the way to it. -->
			<div
				v-if="isHalted"
				class="flex items-start gap-3 p-4 bg-warning/10 border border-warning/30 rounded-lg"
				data-testid="warmup-halted"
			>
				<CircleWarningIcon class="w-5 h-5 text-warning shrink-0 mt-0.5" aria-hidden="true" />
				<div class="min-w-0 space-y-1">
					<p class="text-sm font-medium text-text-primary">
						{{ t('shared.deliveryHub.warmup.plateau') }}
					</p>
					<NuxtLink v-if="isAdmin" to="/dashboard/admin/delivery" class="link text-sm font-medium">
						{{ t('shared.campaignRefusal.fix.deliveryHub') }}
					</NuxtLink>
				</div>
			</div>

			<template v-else>
				<!-- Progress -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.campaigns.detail.edit.warmup.progress') }}
						</p>
						<p class="text-sm font-medium text-text-primary">
							{{ t('dashboard.campaigns.detail.edit.warmup.dayOf', { day, total: WARMUP_DAYS }) }}
						</p>
					</div>
					<div
						class="w-full h-2.5 bg-bg-surface rounded-full overflow-hidden"
						role="progressbar"
						aria-valuemin="0"
						:aria-valuemax="WARMUP_DAYS"
						:aria-valuenow="day"
						:aria-label="t('dashboard.campaigns.detail.edit.warmup.progress')"
					>
						<div
							class="ui-meter-fill h-full bg-brand rounded-full transition-transform duration-(--motion-slow)"
							:style="meterFillStyle(Math.min(100, Math.round((day / WARMUP_DAYS) * 100)))"
						/>
					</div>
				</div>

				<!-- Today's Capacity, as the send gate counts it -->
				<div
					v-if="remainingToday !== null"
					class="flex items-center justify-between p-3 bg-bg-surface rounded-lg"
				>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.campaigns.detail.edit.warmup.remainingCapacity') }}
					</p>
					<p class="text-sm font-medium text-text-primary" data-testid="warmup-remaining-today">
						{{
							t(
								'dashboard.campaigns.detail.edit.warmup.remainingToday',
								{ remaining: formatNumber(remainingToday) },
								remainingToday
							)
						}}
					</p>
				</div>
			</template>

			<!-- The multi-day schedule: previewed BEFORE the send, and re-rendered
			     from the refusal itself when pre-flight hands one back. Capacity is a
			     schedule, not a failure. -->
			<!-- A refused send is announced; the preview before it is not. -->
			<CampaignsCapacitySchedulePanel
				v-if="capacityPlan"
				:role="capacityDismissible ? 'alert' : undefined"
				:plan="capacityPlan"
				:dismissible="capacityDismissible"
				@dismiss="emit('dismissCapacity')"
			/>

			<!-- Send Estimate: a multi-day send is a normal state, so the neutral
			     accent tone like the capacity schedule, not a warning. -->
			<div
				v-if="
					!isHalted &&
					!capacityPlan &&
					sendEstimate &&
					audienceSize !== null &&
					sendEstimate.days > 1
				"
				class="flex items-start gap-3 p-3 bg-accent/5 border border-accent/20 rounded-lg"
				data-testid="warmup-estimate"
			>
				<ClockIcon class="w-5 h-5 text-accent shrink-0 mt-0.5" />
				<div>
					<p class="text-sm font-medium text-text-primary">
						{{
							sendEstimate.isTruncated
								? t('dashboard.campaigns.detail.edit.warmup.estimatedDaysMoreThan', {
										days: sendEstimate.days,
									})
								: t(
										'dashboard.campaigns.detail.edit.warmup.estimatedDays',
										{ days: sendEstimate.days },
										sendEstimate.days
									)
						}}
					</p>
					<p class="text-sm text-text-secondary mt-0.5">
						{{
							t(
								'dashboard.campaigns.detail.edit.warmup.estimateDetail',
								{ count: formatNumber(audienceSize) },
								audienceSize
							)
						}}
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
