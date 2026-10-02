<script setup lang="ts">
/**
 * Response-targets (SLA) editor for the Team Inbox: the on/off switch, the
 * first- and next-response targets, whether they count business hours or every
 * hour, the weekly opening hours, the time zone and closed dates. Emits `save`
 * with the policy; the admin page persists it. Presentational.
 */
import {
	SLA_TARGET_UNITS,
	formToPolicy,
	policyFormProblem,
	policyToForm,
	type SlaPolicyShape,
} from '~/utils/inboxSlaPolicyForm';

const props = defineProps<{
	policy: SlaPolicyShape;
	busy?: boolean;
}>();

const emit = defineEmits<{ save: [policy: SlaPolicyShape] }>();

const { t } = useI18n();

const form = reactive(policyToForm(props.policy));
watch(
	() => props.policy,
	(next) => Object.assign(form, policyToForm(next))
);

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const weekdayLabel = (day: number) =>
	t(`components.autonomy.autonomyWorkingHours.weekdays.${WEEKDAY_KEYS[day]}`);

const unitOptions = computed(() =>
	SLA_TARGET_UNITS.map((unit) => ({
		value: unit,
		label: t(`components.inbox.inboxSlaPolicyForm.units.${unit}`),
	}))
);
const modeOptions = computed(() => [
	{ value: 'business', label: t('components.inbox.inboxSlaPolicyForm.mode.business') },
	{ value: 'calendar', label: t('components.inbox.inboxSlaPolicyForm.mode.calendar') },
]);

const timeZones = (() => {
	try {
		return (
			(Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
			[]
		);
	} catch {
		return [];
	}
})();

const newHoliday = ref('');
function addHoliday() {
	const day = newHoliday.value;
	if (day && !form.holidays.includes(day)) form.holidays = [...form.holidays, day].sort();
	newHoliday.value = '';
}
function removeHoliday(day: string) {
	form.holidays = form.holidays.filter((d) => d !== day);
}

const problem = computed(() => {
	const key = policyFormProblem(formToPolicy(form));
	return key ? t(key) : null;
});

function save() {
	if (problem.value) return;
	emit('save', formToPolicy(form));
}
</script>

<template>
	<div class="space-y-6" data-testid="inbox-sla-policy-form">
		<UiCard>
			<div class="flex items-center justify-between gap-4">
				<div>
					<h2 class="text-base font-medium text-text-primary">
						{{ t('components.inbox.inboxSlaPolicyForm.enabledTitle') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.inbox.inboxSlaPolicyForm.enabledHint') }}
					</p>
				</div>
				<UiSwitch
					v-model="form.isEnabled"
					:label="t('components.inbox.inboxSlaPolicyForm.enabledTitle')"
				/>
			</div>
		</UiCard>

		<UiCard>
			<h2 class="text-base font-medium text-text-primary mb-4">
				{{ t('components.inbox.inboxSlaPolicyForm.targetsTitle') }}
			</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div v-for="which in ['first', 'next'] as const" :key="which">
					<p class="text-sm font-medium text-text-primary">
						{{ t(`components.inbox.inboxSlaPolicyForm.${which}Label`) }}
					</p>
					<p class="text-xs text-text-tertiary mb-2">
						{{ t(`components.inbox.inboxSlaPolicyForm.${which}Hint`) }}
					</p>
					<div class="flex items-center gap-2">
						<input
							v-model.number="form[which].amount"
							type="number"
							min="1"
							class="input w-24"
							:aria-label="t(`components.inbox.inboxSlaPolicyForm.${which}Label`)"
						/>
						<UiSelect
							v-model="form[which].unit"
							:options="unitOptions"
							size="sm"
							:aria-label="t('components.inbox.inboxSlaPolicyForm.unitLabel')"
						/>
					</div>
				</div>
			</div>
		</UiCard>

		<UiCard>
			<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
				<h2 class="text-base font-medium text-text-primary">
					{{ t('components.inbox.inboxSlaPolicyForm.hoursTitle') }}
				</h2>
				<UiSegmentedControl
					v-model="form.hoursMode"
					:options="modeOptions"
					size="sm"
					fit="content"
				/>
			</div>
			<p class="text-sm text-text-secondary mb-4">
				{{
					form.hoursMode === 'business'
						? t('components.inbox.inboxSlaPolicyForm.mode.businessHint')
						: t('components.inbox.inboxSlaPolicyForm.mode.calendarHint')
				}}
			</p>

			<div class="mb-4">
				<label for="sla-time-zone" class="text-sm font-medium text-text-primary">
					{{ t('components.inbox.inboxSlaPolicyForm.timeZone') }}
				</label>
				<input
					id="sla-time-zone"
					v-model="form.timeZone"
					type="text"
					list="sla-time-zones"
					class="input w-full mt-1"
					autocomplete="off"
				/>
				<datalist id="sla-time-zones">
					<option v-for="zone in timeZones" :key="zone" :value="zone" />
				</datalist>
			</div>

			<template v-if="form.hoursMode === 'business'">
				<ul class="divide-y divide-border-subtle" data-testid="inbox-sla-days">
					<li
						v-for="row in form.days"
						:key="row.day"
						class="flex flex-wrap items-center gap-3 py-2"
					>
						<UiCheckbox v-model="row.isOpen" :label="weekdayLabel(row.day)" class="w-32" />
						<template v-if="row.isOpen">
							<input
								v-model="row.start"
								type="time"
								class="input"
								:aria-label="
									t('components.inbox.inboxSlaPolicyForm.opensAt', { day: weekdayLabel(row.day) })
								"
							/>
							<span class="text-text-tertiary" aria-hidden="true">–</span>
							<input
								v-model="row.end"
								type="time"
								class="input"
								:aria-label="
									t('components.inbox.inboxSlaPolicyForm.closesAt', { day: weekdayLabel(row.day) })
								"
							/>
						</template>
						<span v-else class="text-sm text-text-tertiary">
							{{ t('components.inbox.inboxSlaPolicyForm.closed') }}
						</span>
					</li>
				</ul>

				<div class="mt-6">
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.inbox.inboxSlaPolicyForm.holidaysTitle') }}
					</p>
					<p class="text-xs text-text-tertiary mb-2">
						{{ t('components.inbox.inboxSlaPolicyForm.holidaysHint') }}
					</p>
					<div class="flex items-center gap-2">
						<input
							v-model="newHoliday"
							type="date"
							class="input"
							:aria-label="t('components.inbox.inboxSlaPolicyForm.holidayDate')"
						/>
						<UiButton variant="secondary" size="sm" :disabled="!newHoliday" @click="addHoliday">
							{{ t('components.inbox.inboxSlaPolicyForm.addHoliday') }}
						</UiButton>
					</div>
					<ul v-if="form.holidays.length > 0" class="mt-3 flex flex-wrap gap-2">
						<li
							v-for="day in form.holidays"
							:key="day"
							class="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary tabular-nums"
						>
							{{ day }}
							<button
								type="button"
								class="text-text-tertiary hover:text-error"
								:aria-label="t('components.inbox.inboxSlaPolicyForm.removeHoliday', { day })"
								@click="removeHoliday(day)"
							>
								<Icon name="lucide:x" class="w-3 h-3" />
							</button>
						</li>
					</ul>
				</div>
			</template>
		</UiCard>

		<div class="flex items-center justify-end gap-3">
			<p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>
			<UiButton class="gap-2" :disabled="busy || !!problem" @click="save">
				<Icon name="lucide:save" class="w-4 h-4" />
				{{ t('components.inbox.inboxSlaPolicyForm.save') }}
			</UiButton>
		</div>
	</div>
</template>
