<script setup lang="ts">
/**
 * Daily-brief email delivery (idea 29).
 *
 * Off by default — a product that starts mailing you unasked is a product you
 * turn off. Once on, the only choice is WHEN, in local time, because that is the
 * only thing about a digest a person actually has an opinion about.
 *
 * The timezone offset travels WITH the preference: the sender is a cron with no
 * request behind it, so it cannot ask the browser what time it is where you are.
 * This component keeps that offset honest — it re-saves it whenever the browser's
 * has changed since the preference was written, so the first visit after a DST
 * shift corrects the schedule instead of leaving the brief an hour off forever.
 */
import {
	POSTBOX_BRIEF_TIME_DEFAULT_MINUTE,
	minuteToTimeInput,
	timeInputToMinute,
} from '~/utils/postboxBriefSchedule';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';

const { t } = useI18n();
const { dailyBriefEmail, setDailyBriefEmail, isSaving } = usePostboxSettings();

const enabled = computed(() => dailyBriefEmail.value?.enabled === true);
const timeValue = computed(() =>
	minuteToTimeInput(dailyBriefEmail.value?.minute ?? POSTBOX_BRIEF_TIME_DEFAULT_MINUTE)
);

/** The browser's CURRENT offset, in the sign convention the backend stores. */
function browserOffsetMinutes(): number {
	return -new Date().getTimezoneOffset();
}

async function save(next: { enabled: boolean; minute: number }) {
	await setDailyBriefEmail({ ...next, utcOffsetMinutes: browserOffsetMinutes() });
}

function onToggle(value: boolean) {
	void save({
		enabled: value,
		minute: dailyBriefEmail.value?.minute ?? POSTBOX_BRIEF_TIME_DEFAULT_MINUTE,
	});
}

function onTime(value: string) {
	const minute = timeInputToMinute(value);
	if (minute === null) return;
	void save({ enabled: enabled.value, minute });
}

// "Changed from default" markers. Off is the default, so the switch is marked
// while delivery is on; the time is marked when it is not the default hour.
// Both read the stored preference, which is null until someone saves one (and
// while the row loads), so nothing is marked before the row answers.
const minuteChanged = computed(
	() =>
		dailyBriefEmail.value !== null &&
		dailyBriefEmail.value.minute !== POSTBOX_BRIEF_TIME_DEFAULT_MINUTE
);

function resetEnabled() {
	void save({
		enabled: false,
		minute: dailyBriefEmail.value?.minute ?? POSTBOX_BRIEF_TIME_DEFAULT_MINUTE,
	});
}

function resetTime() {
	void save({ enabled: enabled.value, minute: POSTBOX_BRIEF_TIME_DEFAULT_MINUTE });
}

// DST correction. Only while delivery is ON, and only when the offset actually
// moved — an unconditional write would put a mutation on every page load.
watch(
	dailyBriefEmail,
	(pref) => {
		if (!pref?.enabled) return;
		if (pref.utcOffsetMinutes === browserOffsetMinutes()) return;
		void save({ enabled: true, minute: pref.minute });
	},
	{ immediate: true }
);
</script>

<template>
	<section id="daily-brief" class="card scroll-mt-6">
		<header class="mb-3">
			<h2 class="font-semibold">
				{{ t('components.postbox.postboxDailyBriefSettings.title') }}
			</h2>
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxDailyBriefSettings.description') }}
			</p>
		</header>

		<div class="flex items-center justify-between gap-4 text-sm">
			<span class="flex items-center gap-2">
				<label for="daily-brief-enabled">
					{{ t('components.postbox.postboxDailyBriefSettings.enable') }}
				</label>
				<SettingsResetToDefault
					:changed="enabled"
					:label="t('components.postbox.postboxDailyBriefSettings.enable')"
					:disabled="isSaving"
					@reset="resetEnabled"
				/>
			</span>
			<UiSwitch
				id="daily-brief-enabled"
				:model-value="enabled"
				:disabled="isSaving"
				@update:model-value="onToggle"
			/>
		</div>

		<div v-if="enabled" class="mt-3 flex items-center gap-2">
			<label for="daily-brief-time" class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxDailyBriefSettings.timeLabel') }}
			</label>
			<input
				id="daily-brief-time"
				type="time"
				class="input w-32"
				:value="timeValue"
				:disabled="isSaving"
				@change="onTime(($event.target as HTMLInputElement).value)"
			/>
			<!-- Says the quiet part out loud: the time is YOUR clock, and the send
			     window is coarse because a digest is not an alarm. -->
			<span class="text-xs text-text-tertiary">
				{{ t('components.postbox.postboxDailyBriefSettings.localTimeHint') }}
			</span>
			<SettingsResetToDefault
				class="ml-auto"
				:changed="minuteChanged"
				:label="t('components.settings.resetToDefault.names.dailyBriefTime')"
				:disabled="isSaving"
				@reset="resetTime"
			/>
		</div>
	</section>
</template>
