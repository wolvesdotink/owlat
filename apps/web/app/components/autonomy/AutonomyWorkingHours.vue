<script setup lang="ts">
/**
 * Working-hours window editor.
 *
 * Lets an owner confine AUTONOMOUS auto-sends to business hours in a chosen
 * timezone; out-of-hours replies are held for morning human review (enforced
 * server-side in the route step). Emits `save` with the window; the parent page
 * persists it via agentConfigMutations.updateConfig. Prop-driven + presentational.
 */
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
	enabled: false,
	timezone: '',
	start: 9 * 60,
	end: 17 * 60,
	days: () => [1, 2, 3, 4, 5],
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
				<UiIconBox icon="lucide:clock" size="sm" variant="surface" />
				<div>
					<h3 class="text-base font-medium text-text-primary">
						{{ t('components.autonomy.autonomyWorkingHours.title') }}
					</h3>
					<p class="text-xs text-text-tertiary">
						{{ t('components.autonomy.autonomyWorkingHours.subtitle') }}
					</p>
				</div>
			</div>
			<UiToggle
				v-model="form.enabled"
				:label="
					form.enabled
						? t('components.autonomy.autonomyWorkingHours.on')
						: t('components.autonomy.autonomyWorkingHours.off')
				"
				size="sm"
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

			<div class="flex items-center gap-4">
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
				<Icon name="lucide:save" class="w-4 h-4" />
				{{ t('components.autonomy.autonomyWorkingHours.save') }}
			</UiButton>
		</div>
	</UiCard>
</template>
