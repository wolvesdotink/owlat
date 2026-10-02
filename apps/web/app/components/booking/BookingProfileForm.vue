<script setup lang="ts">
/**
 * The booking page itself: its link, the name it shows, the time zone the hours
 * are in, the weekly hours, the dates that differ, and the rules (minimum
 * notice, how far ahead, the buffer between meetings). Seeded from the stored
 * page, or from sensible defaults (Monday to Friday, nine to five, in this
 * browser's zone) before the first save.
 */
import { api } from '@owlat/api';
import { BOOKING_LIMITS, isValidBookingSlug } from '@owlat/shared/booking';
import type { BookingTimeRange, BookingWeeklyRange } from '@owlat/shared/booking';
import BookingRangesEditor from '~/components/booking/BookingRangesEditor.vue';
import {
	FORM_WEEKDAYS,
	defaultWeeklyHours,
	formRangeProblem,
	overridesFromStored,
	overridesToStored,
	weeklyFromStored,
	weeklyToStored,
	type FormOverride,
} from '~/utils/bookingForm';
import { browserTimeZone, formatDayKey, timeZoneOptions } from '~/utils/bookingSlots';

export interface StoredBookingProfile {
	slug: string;
	displayName: string | null;
	timeZone: string;
	weeklyHours: BookingWeeklyRange[];
	dateOverrides: { date: string; ranges: BookingTimeRange[] }[];
	minimumNoticeMinutes: number;
	horizonDays: number;
	bufferMinutes: number;
}

const props = defineProps<{
	profile: StoredBookingProfile | null;
	suggestedSlug: string;
	siteOrigin: string;
}>();

const { t, locale } = useI18n();

const error = ref<string | null>(null);
const save = useBackendOperation(api.booking.settings.saveProfile, {
	label: () => t('components.booking.profile.saveOperation'),
	inlineTarget: error,
});

function seed() {
	const stored = props.profile;
	return {
		slug: stored?.slug ?? (isValidBookingSlug(props.suggestedSlug) ? props.suggestedSlug : ''),
		displayName: stored?.displayName ?? '',
		timeZone: stored?.timeZone ?? browserTimeZone(),
		weekly: stored ? weeklyFromStored(stored.weeklyHours) : defaultWeeklyHours(),
		overrides: stored ? overridesFromStored(stored.dateOverrides) : ([] as FormOverride[]),
		noticeHours: stored ? stored.minimumNoticeMinutes / 60 : 4,
		horizonDays: stored?.horizonDays ?? 30,
		bufferMinutes: stored?.bufferMinutes ?? 0,
	};
}

const form = reactive(seed());
watch(
	() => props.profile,
	() => Object.assign(form, seed())
);

const zones = computed(() => timeZoneOptions(form.timeZone));
const weekdayName = (weekday: number) =>
	new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' }).format(
		// 2024-01-07 was a Sunday.
		Date.UTC(2024, 0, 7 + weekday)
	);

const slugValid = computed(() => isValidBookingSlug(form.slug.trim().toLowerCase()));
const hasRangeProblem = computed(
	() =>
		FORM_WEEKDAYS.some((weekday) => formRangeProblem(form.weekly[weekday] ?? []) !== null) ||
		form.overrides.some((entry) => !entry.date || formRangeProblem(entry.ranges) !== null)
);
const canSave = computed(() => slugValid.value && !hasRangeProblem.value && !save.isLoading.value);

const newOverrideDate = ref('');
function addOverride() {
	const date = newOverrideDate.value;
	if (!date || form.overrides.some((entry) => entry.date === date)) return;
	if (form.overrides.length >= BOOKING_LIMITS.dateOverridesMax) return;
	form.overrides = [...form.overrides, { date, ranges: [] }].sort((a, b) =>
		a.date.localeCompare(b.date)
	);
	newOverrideDate.value = '';
}

function removeOverride(date: string) {
	form.overrides = form.overrides.filter((entry) => entry.date !== date);
}

const savedAt = ref<number | null>(null);
async function submit() {
	if (!canSave.value) return;
	const result = await save.run({
		slug: form.slug.trim().toLowerCase(),
		displayName: form.displayName.trim() || undefined,
		timeZone: form.timeZone,
		weeklyHours: weeklyToStored(form.weekly),
		dateOverrides: overridesToStored(form.overrides),
		minimumNoticeMinutes: Math.round(Number(form.noticeHours) * 60),
		horizonDays: Math.round(Number(form.horizonDays)),
		bufferMinutes: Math.round(Number(form.bufferMinutes)),
	});
	if (result.ok) savedAt.value = Date.now();
}
</script>

<template>
	<form class="space-y-6" data-testid="booking-profile-form" @submit.prevent="submit">
		<section class="card space-y-4 p-5">
			<h2 class="text-base font-semibold">{{ t('components.booking.profile.pageHeading') }}</h2>
			<div>
				<label for="booking-slug" class="mb-1 block text-sm font-medium">
					{{ t('components.booking.profile.slug') }}
				</label>
				<div class="flex items-center rounded-lg border border-border-subtle bg-bg-surface">
					<span class="shrink-0 truncate pl-3 text-sm text-text-tertiary"
						>{{ siteOrigin }}/book/</span
					>
					<input
						id="booking-slug"
						v-model="form.slug"
						type="text"
						class="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm outline-none"
						:maxlength="BOOKING_LIMITS.slugMaxLength"
						autocapitalize="off"
						spellcheck="false"
						required
					/>
				</div>
				<p
					class="mt-1 text-xs"
					:class="slugValid || !form.slug ? 'text-text-tertiary' : 'text-error'"
				>
					{{ t('components.booking.profile.slugHint') }}
				</p>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="booking-display-name" class="mb-1 block text-sm font-medium">
						{{ t('components.booking.profile.displayName') }}
					</label>
					<input
						id="booking-display-name"
						v-model="form.displayName"
						type="text"
						class="input w-full"
						:maxlength="BOOKING_LIMITS.displayNameMaxLength"
						:placeholder="t('components.booking.profile.displayNamePlaceholder')"
					/>
				</div>
				<div>
					<label for="booking-time-zone" class="mb-1 block text-sm font-medium">
						{{ t('components.booking.profile.timeZone') }}
					</label>
					<select id="booking-time-zone" v-model="form.timeZone" class="input w-full">
						<option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
					</select>
				</div>
			</div>
		</section>

		<section class="card space-y-4 p-5">
			<div>
				<h2 class="text-base font-semibold">{{ t('components.booking.profile.weeklyHeading') }}</h2>
				<p class="text-sm text-text-secondary">{{ t('components.booking.profile.weeklyIntro') }}</p>
			</div>
			<div
				v-for="weekday in FORM_WEEKDAYS"
				:key="weekday"
				class="grid gap-2 border-t border-border-subtle pt-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
			>
				<p class="py-1.5 text-sm font-medium">{{ weekdayName(weekday) }}</p>
				<BookingRangesEditor v-model="form.weekly[weekday]!" :label="weekdayName(weekday)" />
			</div>
		</section>

		<section class="card space-y-4 p-5">
			<div>
				<h2 class="text-base font-semibold">
					{{ t('components.booking.profile.overridesHeading') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.booking.profile.overridesIntro') }}
				</p>
			</div>
			<div
				v-for="entry in form.overrides"
				:key="entry.date"
				class="grid gap-2 border-t border-border-subtle pt-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto]"
			>
				<p class="py-1.5 text-sm font-medium">{{ formatDayKey(entry.date, locale) }}</p>
				<BookingRangesEditor v-model="entry.ranges" :label="formatDayKey(entry.date, locale)" />
				<UiButton variant="ghost" size="sm" @click="removeOverride(entry.date)">
					{{ t('components.booking.profile.removeOverride') }}
				</UiButton>
			</div>
			<div class="flex flex-wrap items-end gap-2">
				<label class="text-sm">
					<span class="mb-1 block text-text-secondary">{{
						t('components.booking.profile.overrideDate')
					}}</span>
					<input v-model="newOverrideDate" type="date" class="input" />
				</label>
				<UiButton variant="secondary" :disabled="!newOverrideDate" @click="addOverride">
					{{ t('components.booking.profile.addOverride') }}
				</UiButton>
			</div>
		</section>

		<section class="card space-y-4 p-5">
			<h2 class="text-base font-semibold">{{ t('components.booking.profile.rulesHeading') }}</h2>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="text-sm">
					<span class="mb-1 block font-medium">{{ t('components.booking.profile.notice') }}</span>
					<input
						v-model.number="form.noticeHours"
						type="number"
						min="0"
						:max="BOOKING_LIMITS.noticeMaxMinutes / 60"
						step="1"
						class="input w-full"
					/>
					<span class="mt-1 block text-xs text-text-tertiary">{{
						t('components.booking.profile.noticeHint')
					}}</span>
				</label>
				<label class="text-sm">
					<span class="mb-1 block font-medium">{{ t('components.booking.profile.horizon') }}</span>
					<input
						v-model.number="form.horizonDays"
						type="number"
						:min="BOOKING_LIMITS.horizonMinDays"
						:max="BOOKING_LIMITS.horizonMaxDays"
						class="input w-full"
					/>
					<span class="mt-1 block text-xs text-text-tertiary">{{
						t('components.booking.profile.horizonHint')
					}}</span>
				</label>
				<label class="text-sm">
					<span class="mb-1 block font-medium">{{ t('components.booking.profile.buffer') }}</span>
					<input
						v-model.number="form.bufferMinutes"
						type="number"
						min="0"
						:max="BOOKING_LIMITS.bufferMaxMinutes"
						step="5"
						class="input w-full"
					/>
					<span class="mt-1 block text-xs text-text-tertiary">{{
						t('components.booking.profile.bufferHint')
					}}</span>
				</label>
			</div>
		</section>

		<div class="flex flex-wrap items-center gap-3">
			<UiButton type="submit" :disabled="!canSave" :loading="save.isLoading.value">
				{{ profile ? t('common.save') : t('components.booking.profile.create') }}
			</UiButton>
			<p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
			<p v-else-if="savedAt" class="text-sm text-text-tertiary" role="status">
				{{ t('components.booking.profile.saved') }}
			</p>
		</div>
	</form>
</template>
