<script setup lang="ts">
/**
 * Quiet-hours editor: the on/off switch, the From/To clock and the weekday
 * mask. Stateless — it renders the window it is given and emits a whole new
 * one, so the parent owns the single save call and nothing here can persist a
 * half-edited window.
 */
import type { PostboxQuietHours } from '~/utils/postboxQuietHours';
import {
	formatMinuteOfDay,
	parseMinuteOfDay,
	POSTBOX_WEEKDAY_ORDER,
} from '~/utils/postboxQuietHours';

const props = defineProps<{ value: PostboxQuietHours; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update', value: PostboxQuietHours): void }>();

const { t } = useI18n();

// Module-scope registry: weekday VALUES with message keys, resolved at render
// time so switching locale relabels the chips.
const WEEKDAY_LABEL_KEYS: Record<number, string> = {
	0: 'components.postbox.postboxNotificationSettings.quietHours.weekday.sun',
	1: 'components.postbox.postboxNotificationSettings.quietHours.weekday.mon',
	2: 'components.postbox.postboxNotificationSettings.quietHours.weekday.tue',
	3: 'components.postbox.postboxNotificationSettings.quietHours.weekday.wed',
	4: 'components.postbox.postboxNotificationSettings.quietHours.weekday.thu',
	5: 'components.postbox.postboxNotificationSettings.quietHours.weekday.fri',
	6: 'components.postbox.postboxNotificationSettings.quietHours.weekday.sat',
};

const startTime = computed(() => formatMinuteOfDay(props.value.startMinute));
const endTime = computed(() => formatMinuteOfDay(props.value.endMinute));

// A window whose end is at or before its start runs past midnight; say so,
// because "22:00 to 07:00" otherwise reads as an empty range.
const isOvernight = computed(() => props.value.endMinute <= props.value.startMinute);
const hasNoDays = computed(() => props.value.days.length === 0);

function onEnabledChange(event: Event) {
	emit('update', { ...props.value, enabled: (event.target as HTMLInputElement).checked });
}

function onTimeChange(field: 'startMinute' | 'endMinute', event: Event) {
	const minute = parseMinuteOfDay((event.target as HTMLInputElement).value);
	// An empty or half-typed time input yields null — keep the stored window
	// rather than persisting a midnight the user never chose.
	if (minute === null) return;
	emit('update', { ...props.value, [field]: minute });
}

function toggleDay(day: number) {
	const days = props.value.days.includes(day)
		? props.value.days.filter((d) => d !== day)
		: [...props.value.days, day].sort((a, b) => a - b);
	emit('update', { ...props.value, days });
}
</script>

<template>
	<div class="px-5 py-4 border-t border-border-subtle">
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-quiet-hours" class="font-medium text-sm block">
					{{ t('components.postbox.postboxNotificationSettings.quietHours.label') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxNotificationSettings.quietHours.hint') }}
				</p>
			</div>
			<input
				id="postbox-quiet-hours"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="value.enabled"
				:disabled="disabled"
				@change="onEnabledChange"
			/>
		</div>

		<div v-if="value.enabled" class="mt-3 flex flex-wrap items-center gap-3">
			<label class="text-xs text-text-tertiary" for="postbox-quiet-from">
				{{ t('components.postbox.postboxNotificationSettings.quietHours.from') }}
			</label>
			<input
				id="postbox-quiet-from"
				type="time"
				class="input w-32"
				:value="startTime"
				:disabled="disabled"
				@change="onTimeChange('startMinute', $event)"
			/>
			<label class="text-xs text-text-tertiary" for="postbox-quiet-to">
				{{ t('components.postbox.postboxNotificationSettings.quietHours.to') }}
			</label>
			<input
				id="postbox-quiet-to"
				type="time"
				class="input w-32"
				:value="endTime"
				:disabled="disabled"
				@change="onTimeChange('endMinute', $event)"
			/>
		</div>

		<div v-if="value.enabled" class="mt-3">
			<p class="text-xs text-text-tertiary mb-1.5">
				{{ t('components.postbox.postboxNotificationSettings.quietHours.days') }}
			</p>
			<div class="flex flex-wrap gap-1.5">
				<button
					v-for="day in POSTBOX_WEEKDAY_ORDER"
					:key="day"
					type="button"
					class="px-2 py-0.5 rounded text-xs border"
					:class="
						value.days.includes(day)
							? 'border-brand text-brand'
							: 'border-border-subtle text-text-tertiary'
					"
					:aria-pressed="value.days.includes(day)"
					:disabled="disabled"
					@click="toggleDay(day)"
				>
					{{ t(WEEKDAY_LABEL_KEYS[day] ?? '') }}
				</button>
			</div>
			<p v-if="hasNoDays" class="text-xs text-warning mt-1.5">
				{{ t('components.postbox.postboxNotificationSettings.quietHours.noDays') }}
			</p>
			<p v-else-if="isOvernight" class="text-xs text-text-tertiary mt-1.5">
				{{ t('components.postbox.postboxNotificationSettings.quietHours.overnight') }}
			</p>
		</div>
	</div>
</template>
