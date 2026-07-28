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
	capacityFinishDayAt,
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

const headline = computed(() => capacityScheduleHeadline(props.plan));

/** A finish date is only honest when the enumeration actually reached the end. */
const finishesOn = computed(() => {
	if (props.plan.truncated) return null;
	return formatCapacityDay(capacityFinishDayAt(props.plan));
});

/**
 * The first few days of the plan, so "over N days" is concrete rather than
 * abstract. Each row carries its OWN date, derived from the plan: the slices are
 * anchored on the send START, not on `now`, so a campaign scheduled three days
 * out must not label its first slice "Today".
 */
const previewSlices = computed(() => {
	const now = props.now ?? Date.now();
	return props.plan.slices.slice(0, 5).map((recipients, index) => {
		const dayStart = capacitySliceDayStart(props.plan, index);
		return {
			recipients,
			label: isCapacityDayToday(dayStart, now) ? 'Today' : formatCapacityDay(dayStart, 'short'),
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
				Your sending capacity is still warming up, so this audience is paced across several days
				rather than sent in one go.
				<span v-if="finishesOn">Everyone is reached by {{ finishesOn }}.</span>
			</p>

			<ul class="mt-3 space-y-1" data-testid="capacity-schedule-slices">
				<li
					v-for="(slice, index) in previewSlices"
					:key="index"
					class="flex items-center justify-between text-sm text-text-secondary"
				>
					<span>{{ slice.label }}</span>
					<span class="tabular-nums">{{ slice.recipients.toLocaleString() }} recipients</span>
				</li>
				<li v-if="hiddenSliceCount > 0" class="text-sm text-text-tertiary">
					+{{ hiddenSliceCount }} more {{ hiddenSliceCount === 1 ? 'day' : 'days' }}
				</li>
			</ul>

			<p v-if="plan.audienceUnderCounted" class="text-sm text-text-tertiary mt-3">
				This audience is larger than we counted exactly, so the schedule above is a floor — the real
				send may take longer.
			</p>
			<p v-if="plan.truncated" class="text-sm text-text-tertiary mt-3">
				Only the first {{ plan.covered.toLocaleString() }} recipients could be scheduled at your
				current capacity. Reduce the audience, or send it in stages.
			</p>

			<p class="text-sm text-text-secondary mt-3">
				To start it now, reduce the audience. To keep the whole audience, schedule the campaign for
				a later date — it is judged against the larger capacity you will have then.
			</p>

			<button
				v-if="dismissible"
				type="button"
				class="btn btn-secondary btn-sm mt-3"
				@click="$emit('dismiss')"
			>
				Change send options
			</button>
		</div>
	</div>
</template>
