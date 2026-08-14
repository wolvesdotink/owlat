<script setup lang="ts">
/**
 * The campaign capacity refusal, rendered as a SCHEDULE rather than an error.
 *
 * When pre-flight decides a campaign provably cannot finish inside the MTA's
 * message-retention horizon it hands back the multi-day plan it would take.
 * Deliverability plan D14: a multi-day send is a normal, visible state for a
 * warming deployment — never an error, never a surprise. So this is an
 * informational panel in the neutral/accent palette, not the red error
 * treatment, and it names the one thing the operator can actually do today
 * (schedule the send for a later date, which is judged against the larger
 * warm-up capacity it will have then).
 *
 * Deliberately says only what the plan knows: a truncated enumeration is never
 * quoted as a finish date, and an under-counted audience is quoted as a floor.
 */
import {
	capacityFinishSentence,
	capacityScheduleHeadline,
	capacitySliceDayStart,
	formatCapacityDay,
	isCapacityDayToday,
	type CampaignCapacitySchedulePlan,
} from '~/lib/campaignCapacityRefusal';

const props = defineProps<{
	plan: CampaignCapacitySchedulePlan;
	/** Shown when the operator can dismiss the panel and change the send options. */
	dismissible?: boolean;
	/**
	 * Clock override for tests; defaults to the render-time wall clock. Only used
	 * to decide which row (if any) is labelled "Today".
	 */
	now?: number;
}>();

defineEmits<{ dismiss: [] }>();

const { t, locale } = useI18n();

/**
 * The sentences the plan itself decides live in `~/lib/campaignCapacityRefusal`,
 * which is module scope and therefore never calls `useI18n`: it hands back a
 * catalog key (with its parameters when it has any), and the render boundary —
 * here — is what turns that into words.
 */
type CapacityMessage = string | { key: string; params?: Record<string, unknown> };
const message = (value: CapacityMessage): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const headline = computed(() => message(capacityScheduleHeadline(props.plan)));

/**
 * A finish date is only honest when the enumeration reached the end, and only
 * unqualified when the audience behind it was counted exactly — both decided in
 * `capacityFinishSentence` beside the headline they have to agree with.
 */
const finishesOn = computed(() => {
	const sentence = capacityFinishSentence(props.plan);
	return sentence === null ? null : message(sentence);
});

/**
 * The first few days of the plan, so "over N days" is concrete rather than
 * abstract. Each row carries its OWN date, derived from the plan: the slices are
 * anchored on the send START, not on `now`, so a campaign scheduled three days
 * out must not label its first slice "Today".
 *
 * A slice is RECIPIENTS, which is what the row says it is. The backend decides
 * the refusal on own-MTA message volume but re-denominates the schedule into the
 * walker's recipient plan before it leaves the gate
 * (`campaigns/capacityPreflight.ts`) — under a split route the two differ by the
 * own arm's share.
 */
const previewSlices = computed(() => {
	const now = props.now ?? Date.now();
	return props.plan.slices.slice(0, 5).map((recipients, index) => {
		const dayStart = capacitySliceDayStart(props.plan, index);
		return {
			recipients,
			label: isCapacityDayToday(dayStart, now)
				? t('common.today')
				: formatCapacityDay(dayStart, 'short'),
		};
	});
});
const hiddenSliceCount = computed(() => Math.max(0, props.plan.slices.length - 5));
</script>

<template>
	<div
		class="flex items-start gap-3 p-4 bg-accent/5 border border-accent/20 rounded-lg"
		data-testid="capacity-schedule-panel"
	>
		<Icon name="lucide:calendar-clock" class="w-5 h-5 text-accent shrink-0 mt-0.5" />
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium text-text-primary">{{ headline }}</p>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('components.campaigns.capacitySchedulePanel.intro') }}
				<span v-if="finishesOn">{{ finishesOn }}</span>
			</p>

			<ul class="mt-3 space-y-1" data-testid="capacity-schedule-slices">
				<li
					v-for="(slice, index) in previewSlices"
					:key="index"
					class="flex items-center justify-between text-sm text-text-secondary"
				>
					<span>{{ slice.label }}</span>
					<span class="tabular-nums">{{
						t('components.campaigns.capacitySchedulePanel.recipients', {
							count: slice.recipients.toLocaleString(locale),
						})
					}}</span>
				</li>
				<li v-if="hiddenSliceCount > 0" class="text-sm text-text-tertiary">
					{{ t('components.campaigns.capacitySchedulePanel.moreDays', hiddenSliceCount) }}
				</li>
			</ul>

			<p v-if="plan.audienceUnderCounted" class="text-sm text-text-tertiary mt-3">
				{{ t('components.campaigns.capacitySchedulePanel.underCounted') }}
			</p>
			<p v-if="plan.truncated" class="text-sm text-text-tertiary mt-3">
				{{
					t('components.campaigns.capacitySchedulePanel.truncated', {
						covered: plan.covered.toLocaleString(locale),
					})
				}}
			</p>

			<p class="text-sm text-text-secondary mt-3">
				{{ t('components.campaigns.capacitySchedulePanel.escape') }}
			</p>

			<UiButton
				variant="secondary"
				size="sm"
				v-if="dismissible"
				type="button"
				class="mt-3"
				@click="$emit('dismiss')"
			>
				{{ t('components.campaigns.capacitySchedulePanel.changeSendOptions') }}
			</UiButton>
		</div>
	</div>
</template>
