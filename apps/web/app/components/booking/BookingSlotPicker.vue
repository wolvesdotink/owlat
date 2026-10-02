<script setup lang="ts">
/**
 * Pick a meeting time: a month calendar whose days with open times are
 * clickable, the open times of the chosen day, and the time zone they are shown
 * in (the visitor's own, detected, switchable). The open times come in as
 * instants; the parent fetches them for the visible month and re-fetches when
 * `month` changes. Used by the public booking page and the guest's reschedule
 * page alike.
 */
import {
	calendarWeeks,
	formatDayKey,
	formatSlotTime,
	groupSlotsByDay,
	timeZoneOptions,
} from '~/utils/bookingSlots';

const props = defineProps<{
	slots: readonly number[];
	loading?: boolean;
	/** The earliest and latest bookable instants, to stop paging past them. */
	earliest?: number;
	latest?: number;
}>();

const timeZone = defineModel<string>('timeZone', { required: true });
const month = defineModel<{ year: number; month: number }>('month', { required: true });
const selected = defineModel<number | null>('selected', { default: null });

const { t, locale } = useI18n();

const days = computed(() => groupSlotsByDay(props.slots, timeZone.value));
const weeks = computed(() => calendarWeeks(month.value.year, month.value.month));
const selectedDay = ref<string | null>(null);

// Land on the first day with open times whenever the times change and the
// chosen day has none (a new month, a new zone, a slot taken meanwhile).
watch(
	days,
	(next) => {
		if (selectedDay.value && next.has(selectedDay.value)) return;
		selectedDay.value = next.keys().next().value ?? null;
	},
	{ immediate: true }
);

const dayTimes = computed(() =>
	selectedDay.value ? (days.value.get(selectedDay.value) ?? []) : []
);

const monthLabel = computed(() =>
	new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
		Date.UTC(month.value.year, month.value.month - 1, 1)
	)
);

const weekdayLabels = computed(() => {
	const format = new Intl.DateTimeFormat(locale.value, { weekday: 'short', timeZone: 'UTC' });
	// 2024-01-01 was a Monday.
	return Array.from({ length: 7 }, (_, i) => format.format(Date.UTC(2024, 0, 1 + i)));
});

function shift(delta: number) {
	const index = month.value.year * 12 + (month.value.month - 1) + delta;
	month.value = { year: Math.floor(index / 12), month: (index % 12) + 1 };
	selected.value = null;
}

const monthKey = (year: number, m: number) => year * 12 + m;
const canGoBack = computed(() => {
	if (props.earliest === undefined) return true;
	const first = new Date(props.earliest);
	return (
		monthKey(month.value.year, month.value.month) >
		monthKey(first.getUTCFullYear(), first.getUTCMonth() + 1)
	);
});
const canGoForward = computed(() => {
	if (props.latest === undefined) return true;
	const last = new Date(props.latest);
	return (
		monthKey(month.value.year, month.value.month) <
		monthKey(last.getUTCFullYear(), last.getUTCMonth() + 1)
	);
});

const zones = computed(() => timeZoneOptions(timeZone.value));

function pickDay(key: string) {
	if (!days.value.has(key)) return;
	selectedDay.value = key;
	selected.value = null;
}
</script>

<template>
	<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_14rem]" data-testid="booking-slot-picker">
		<div>
			<div class="mb-3 flex items-center justify-between gap-2">
				<h3 class="text-base font-semibold capitalize text-text-primary">{{ monthLabel }}</h3>
				<div class="flex items-center gap-1">
					<UiButton
						variant="ghost"
						size="sm"
						:disabled="!canGoBack || loading"
						:aria-label="t('components.booking.slotPicker.previousMonth')"
						@click="shift(-1)"
					>
						<Icon name="lucide:chevron-left" class="h-4 w-4" />
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						:disabled="!canGoForward || loading"
						:aria-label="t('components.booking.slotPicker.nextMonth')"
						@click="shift(1)"
					>
						<Icon name="lucide:chevron-right" class="h-4 w-4" />
					</UiButton>
				</div>
			</div>
			<div class="grid grid-cols-7 gap-1 text-center" :aria-busy="loading">
				<div
					v-for="label in weekdayLabels"
					:key="label"
					aria-hidden="true"
					class="pb-1 text-xs font-medium text-text-tertiary"
				>
					{{ label }}
				</div>
				<template v-for="week in weeks" :key="week[0]!.key">
					<button
						v-for="cell in week"
						:key="cell.key"
						type="button"
						class="aspect-square rounded-lg text-sm transition-colors disabled:cursor-default"
						:class="[
							!cell.inMonth
								? 'invisible'
								: days.has(cell.key)
									? selectedDay === cell.key
										? 'bg-brand text-text-inverse font-semibold'
										: 'bg-brand-subtle text-brand font-semibold hover:bg-brand/20'
									: 'text-text-tertiary',
						]"
						:disabled="!cell.inMonth || !days.has(cell.key)"
						:aria-pressed="selectedDay === cell.key"
						:aria-label="formatDayKey(cell.key, locale)"
						@click="pickDay(cell.key)"
					>
						{{ cell.day }}
					</button>
				</template>
			</div>
			<label class="mt-4 block text-sm">
				<span class="mb-1 block text-text-secondary">{{
					t('components.booking.slotPicker.timeZone')
				}}</span>
				<select v-model="timeZone" class="input w-full" data-testid="booking-time-zone">
					<option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
				</select>
			</label>
		</div>

		<div>
			<p v-if="selectedDay" class="mb-3 text-sm font-medium text-text-primary">
				{{ formatDayKey(selectedDay, locale) }}
			</p>
			<div v-if="loading" class="space-y-2" role="status" :aria-label="t('common.loading')">
				<UiSkeleton v-for="n in 5" :key="n" class="h-10 rounded-lg" />
			</div>
			<p v-else-if="dayTimes.length === 0" class="text-sm text-text-tertiary">
				{{ t('components.booking.slotPicker.noTimes') }}
			</p>
			<ul v-else class="max-h-80 space-y-2 overflow-y-auto pr-1">
				<li v-for="slot in dayTimes" :key="slot">
					<button
						type="button"
						class="w-full rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
						:class="
							selected === slot
								? 'border-brand bg-brand text-text-inverse'
								: 'border-border-subtle text-brand hover:border-brand'
						"
						:aria-pressed="selected === slot"
						data-testid="booking-slot"
						@click="selected = slot"
					>
						{{ formatSlotTime(slot, locale, timeZone) }}
					</button>
				</li>
			</ul>
		</div>
	</div>
</template>
