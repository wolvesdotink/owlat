<script setup lang="ts">
/**
 * One day's open hours: zero or more from–to ranges, each two time inputs, with
 * add and remove. Empty means unavailable. Flags overlapping or inverted ranges
 * in place; the settings form refuses to save while any day has a problem.
 */
import { BOOKING_LIMITS } from '@owlat/shared/booking';
import { formRangeProblem, type FormRange } from '~/utils/bookingForm';

const props = defineProps<{
	/** Accessible name of the day ("Monday", "Dec 24"). */
	label: string;
}>();

const ranges = defineModel<FormRange[]>({ required: true });

const { t } = useI18n();

const problem = computed(() => formRangeProblem(ranges.value));

function add() {
	const last = ranges.value.at(-1);
	ranges.value = [
		...ranges.value,
		last ? { start: last.end, end: '' } : { start: '09:00', end: '17:00' },
	];
}

function remove(index: number) {
	ranges.value = ranges.value.filter((_, i) => i !== index);
}

function update(index: number, field: keyof FormRange, value: string) {
	ranges.value = ranges.value.map((range, i) =>
		i === index ? { ...range, [field]: value } : range
	);
}
</script>

<template>
	<div class="min-w-0 space-y-2">
		<p v-if="ranges.length === 0" class="py-1.5 text-sm text-text-tertiary">
			{{ t('components.booking.ranges.unavailable') }}
		</p>
		<div v-for="(range, index) in ranges" :key="index" class="flex flex-wrap items-center gap-2">
			<input
				type="time"
				class="input w-36"
				:value="range.start"
				:aria-label="t('components.booking.ranges.from', { day: props.label })"
				@input="update(index, 'start', ($event.target as HTMLInputElement).value)"
			/>
			<span class="text-text-tertiary" aria-hidden="true">–</span>
			<input
				type="time"
				class="input w-36"
				:value="range.end"
				:aria-label="t('components.booking.ranges.to', { day: props.label })"
				@input="update(index, 'end', ($event.target as HTMLInputElement).value)"
			/>
			<UiButton
				variant="ghost"
				size="sm"
				:aria-label="t('components.booking.ranges.remove', { day: props.label })"
				@click="remove(index)"
			>
				<Icon name="lucide:x" class="h-4 w-4" />
			</UiButton>
		</div>
		<p v-if="problem" class="text-xs text-error" role="alert">
			{{ t(`components.booking.ranges.problems.${problem}`) }}
		</p>
		<UiButton
			v-if="ranges.length < BOOKING_LIMITS.rangesPerDayMax"
			variant="ghost"
			size="sm"
			@click="add"
		>
			<Icon name="lucide:plus" class="mr-1 h-4 w-4" />
			{{ t('components.booking.ranges.add') }}
		</UiButton>
	</div>
</template>
