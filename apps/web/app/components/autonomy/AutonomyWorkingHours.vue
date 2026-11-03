<script setup lang="ts">
/**
 * Working-hours window editor.
 *
 * Lets an owner confine AUTONOMOUS auto-sends to business hours in a chosen
 * timezone; out-of-hours replies are held for morning human review (enforced
 * server-side in the route step). Emits `save` with the window; the parent page
 * persists it via agent/configMutations.updateConfig. Prop-driven + presentational.
 */
import { WORKING_HOURS_DEFAULTS } from '~/utils/autonomyDefaults';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';
import { ClockIcon, SaveIcon } from '@coolicons/vue';

interface Props {
	enabled?: boolean;
	timezone?: string;
	// Minutes from local midnight.
	start?: number;
	end?: number;
	// Allowed weekdays, 0=Sun … 6=Sat.
	days?: number[];
	busy?: boolean;
}
const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
	enabled: WORKING_HOURS_DEFAULTS.enabled,
	timezone: '',
	start: WORKING_HOURS_DEFAULTS.start,
	end: WORKING_HOURS_DEFAULTS.end,
	days: () => [...WORKING_HOURS_DEFAULTS.days],
	busy: false,
});

const emit = defineEmits<{
	save: [
		payload: { enabled: boolean; timezone: string; start: number; end: number; days: number[] },
	];
}>();

const minutesToHHMM = (m: number): string => {
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
const hhmmToMinutes = (s: string): number => {
	const [h, m] = s.split(':').map((n) => Number.parseInt(n, 10));
	return (Number.isFinite(h) ? h! : 0) * 60 + (Number.isFinite(m) ? m! : 0);
};

const browserTimezone = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
})();

const form = reactive({
	enabled: props.enabled,
	timezone: props.timezone || browserTimezone,
	start: minutesToHHMM(props.start),
	end: minutesToHHMM(props.end),
	days: [...props.days],
});

const weekdayLabels = computed(() =>
	[
		{ value: 1, key: 'mon' },
		{ value: 2, key: 'tue' },
		{ value: 3, key: 'wed' },
		{ value: 4, key: 'thu' },
		{ value: 5, key: 'fri' },
		{ value: 6, key: 'sat' },
		{ value: 0, key: 'sun' },
	].map((day) => ({
		value: day.value,
		label: t(`components.autonomy.autonomyWorkingHours.weekdays.${day.key}`),
	}))
);

const toggleDay = (day: number) => {
	const i = form.days.indexOf(day);
	if (i === -1) form.days.push(day);
	else form.days.splice(i, 1);
};

// The markers compare the draft, so a Reset is an edit like any other and is
// written by Save. The timezone has no marker: unset means this browser's zone,
// which is not one fixed value to return to.
const isEnabledChanged = computed(() => form.enabled !== WORKING_HOURS_DEFAULTS.enabled);
const isWindowChanged = computed(() => {
	const days = [...form.days].sort((a, b) => a - b);
	return (
		hhmmToMinutes(form.start) !== WORKING_HOURS_DEFAULTS.start ||
		hhmmToMinutes(form.end) !== WORKING_HOURS_DEFAULTS.end ||
		days.length !== WORKING_HOURS_DEFAULTS.days.length ||
		days.some((day, i) => day !== WORKING_HOURS_DEFAULTS.days[i])
	);
});

function resetEnabled() {
	form.enabled = WORKING_HOURS_DEFAULTS.enabled;
}

function resetWindow() {
	form.start = minutesToHHMM(WORKING_HOURS_DEFAULTS.start);
	form.end = minutesToHHMM(WORKING_HOURS_DEFAULTS.end);
	form.days = [...WORKING_HOURS_DEFAULTS.days];
}

const handleSave = () => {
	emit('save', {
		enabled: form.enabled,
		timezone: form.timezone.trim() || 'UTC',
		start: hhmmToMinutes(form.start),
		end: hhmmToMinutes(form.end),
		days: [...form.days].sort((a, b) => a - b),
	});
};
</script>

<template>
	<UiCard data-testid="working-hours">
		<div class="flex items-center justify-between mb-4">
			<div class="flex items-center gap-3">
				<UiIconBox :icon="ClockIcon" size="sm" variant="surface" />
				<div>
					<div class="flex items-center gap-2">
						<h3 class="text-base font-medium text-text-primary">
							{{ t('components.autonomy.autonomyWorkingHours.title') }}
						</h3>
						<SettingsResetToDefault
							:changed="isEnabledChanged"
							:label="t('components.autonomy.autonomyWorkingHours.title')"
							:disabled="busy"
							@reset="resetEnabled"
						/>
					</div>
					<p class="text-xs text-text-tertiary">
						{{ t('components.autonomy.autonomyWorkingHours.subtitle') }}
					</p>
				</div>
			</div>
			<UiSwitch
				v-model="form.enabled"
				:label="t('components.autonomy.autonomyWorkingHours.title')"
			/>
		</div>

		<div v-if="form.enabled" class="space-y-4">
			<div>
				<label class="text-sm font-medium text-text-primary">
					{{ t('components.autonomy.autonomyWorkingHours.timezoneLabel') }}
				</label>
				<input
					v-model="form.timezone"
					type="text"
					class="input w-full mt-1"
					:placeholder="t('components.autonomy.autonomyWorkingHours.timezonePlaceholder')"
				/>
			</div>

			<div class="flex items-end gap-4">
				<div>
					<label class="text-sm font-medium text-text-primary">
						{{ t('components.autonomy.autonomyWorkingHours.fromLabel') }}
					</label>
					<input v-model="form.start" type="time" class="input mt-1" />
				</div>
				<div>
					<label class="text-sm font-medium text-text-primary">
						{{ t('components.autonomy.autonomyWorkingHours.toLabel') }}
					</label>
					<input v-model="form.end" type="time" class="input mt-1" />
				</div>
				<!-- One marker for the window: hours and days reset together. -->
				<SettingsResetToDefault
					class="mb-2.5"
					:changed="isWindowChanged"
					:label="t('components.autonomy.autonomyWorkingHours.windowLabel')"
					:disabled="busy"
					@reset="resetWindow"
				/>
			</div>

			<div>
				<label class="text-sm font-medium text-text-primary">
					{{ t('components.autonomy.autonomyWorkingHours.daysLabel') }}
				</label>
				<div class="flex flex-wrap gap-2 mt-2">
					<button
						v-for="d in weekdayLabels"
						:key="d.value"
						type="button"
						class="px-3 py-1 rounded-full text-xs border transition-colors"
						:class="
							form.days.includes(d.value)
								? 'bg-brand-subtle text-brand border-brand/40'
								: 'text-text-tertiary border-border-subtle'
						"
						@click="toggleDay(d.value)"
					>
						{{ d.label }}
					</button>
				</div>
			</div>

			<p class="text-xs text-text-tertiary">
				{{ t('components.autonomy.autonomyWorkingHours.hint') }}
			</p>
		</div>

		<div class="flex justify-end mt-5 pt-4 border-t border-border-subtle">
			<UiButton class="gap-2" :disabled="busy" @click="handleSave">
				<SaveIcon class="w-4 h-4" />
				{{ t('components.autonomy.autonomyWorkingHours.save') }}
			</UiButton>
		</div>
	</UiCard>
</template>
