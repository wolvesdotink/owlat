<script setup lang="ts">
/**
 * Schedule-send dialog (plan idea 9).
 *
 * The preset TIMES are decided by the pure `buildSchedulePresets` (weekday
 * awareness, dedupe, the recipient-anchored row); this file only asks the
 * backend which timezone the recipients are in and turns the result into words.
 *
 * When the org's CRM has ONE distinct timezone on record across this draft's
 * recipients, the header names it, an extra "Tomorrow morning, their time"
 * preset appears, and every row prints both clocks. When it does not — no
 * contact row, no timezone set, or recipients spread across zones — the dialog
 * is exactly what it was: sender-clock presets with a single clock each. It
 * degrades silently; it never guesses a zone.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	buildSchedulePresets,
	soleRecipientTimeZone,
	zoneOffsetMinutes,
	type SchedulePreset,
} from '~/utils/postboxSchedulePresets';

const { t, locale } = useI18n();

const props = withDefaults(
	defineProps<{
		open: boolean;
		/** Scopes the recipient-timezone read; omitted, the dialog stays single-clock. */
		mailboxId?: Id<'mailboxes'>;
		/** The draft's recipients — the addresses a timezone is looked up for. */
		recipients?: string[];
	}>(),
	{ recipients: () => [] }
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
}>();

// Only ask while the dialog is actually open, and only for a draft that has
// recipients: a closed dialog has nothing to label.
const { data: recipientZones } = useConvexQuery(api.mail.contacts.recipientTimeZones, () => {
	if (!props.open || !props.mailboxId || props.recipients.length === 0) return 'skip' as const;
	return { mailboxId: props.mailboxId, emails: props.recipients };
});

/** The single recipient zone to schedule against, or null (say nothing). */
const recipientTimeZone = computed(() => soleRecipientTimeZone(recipientZones.value ?? []));

// Re-read on open so a dialog left mounted across midnight (or a timezone
// change) computes against the real now rather than a stale one.
const now = ref(Date.now());
watch(
	() => props.open,
	(open) => {
		if (open) now.value = Date.now();
	},
	{ immediate: true }
);

const senderOffsetMinutes = computed(() => -new Date(now.value).getTimezoneOffset());
const recipientOffsetMinutes = computed(() =>
	recipientTimeZone.value ? zoneOffsetMinutes(recipientTimeZone.value, now.value) : null
);
/** Both clocks are only worth printing when they actually differ. */
const showsBothClocks = computed(
	() =>
		recipientOffsetMinutes.value !== null &&
		recipientOffsetMinutes.value !== senderOffsetMinutes.value
);

const presets = computed<SchedulePreset[]>(() =>
	buildSchedulePresets({
		now: now.value,
		senderOffsetMinutes: senderOffsetMinutes.value,
		recipientOffsetMinutes: recipientOffsetMinutes.value,
	})
);

/**
 * An instant's wall clock in a given offset, written the way the reader's
 * locale writes it. Formatting the shifted instant as UTC reads it back as that
 * clock without needing an IANA zone name for the sender.
 */
function clockAt(at: number, offsetMinutes: number): string {
	return new Intl.DateTimeFormat(locale.value, {
		timeZone: 'UTC',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(at + offsetMinutes * 60_000));
}

/** "Wednesday" in the reader's language, for the next-weekday preset. */
function weekdayName(at: number, offsetMinutes: number): string {
	return new Intl.DateTimeFormat(locale.value, { timeZone: 'UTC', weekday: 'long' }).format(
		new Date(at + offsetMinutes * 60_000)
	);
}

function presetLabel(preset: SchedulePreset): string {
	// The day-named rows carry the weekday they resolved to, so they read
	// "Monday morning" rather than the generic "next weekday morning".
	return preset.weekday === undefined
		? t(preset.labelKey)
		: t(preset.labelKey, { weekday: weekdayName(preset.at, senderOffsetMinutes.value) });
}

/**
 * The row's right-hand clock. With one clock it is just the time, as before.
 * With two, the anchored clock leads and the other follows in parentheses, so
 * the sender reads what the RECIPIENT will see first on the row that promises
 * their morning.
 */
function presetClock(preset: SchedulePreset): string {
	const mine = clockAt(preset.at, senderOffsetMinutes.value);
	const theirOffset = recipientOffsetMinutes.value;
	if (!showsBothClocks.value || theirOffset === null) return mine;
	const theirs = clockAt(preset.at, theirOffset);
	return preset.anchor === 'recipient'
		? t('components.postbox.postboxScheduleDialog.theirsThenYours', { theirs, yours: mine })
		: t('components.postbox.postboxScheduleDialog.yoursThenTheirs', { yours: mine, theirs });
}

// ── Custom time ──────────────────────────────────────────────────────────────
//
// The native `datetime-local` value is a wall clock with no zone: the browser
// reads it in the sender's own zone, the same clock `senderOffsetMinutes`
// describes. The summary line under the input says which zone that is and
// echoes the exact instant Schedule will emit, so what the sender reads is what
// gets scheduled.

const customDate = ref('');
const customInputId = useId();
const customSummaryId = useId();

/** The sender's IANA zone, for naming the clock; the offset when there is none. */
const senderZoneName = computed(() => {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (zone) return zone;
	const offset = senderOffsetMinutes.value;
	const abs = Math.abs(offset);
	return `UTC${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
});

// The clock validation reads against. It ticks while the dialog is open, so a
// time that was a minute ahead turns into the error line once that minute has
// gone by, and Schedule re-reads it on click: `min` on the native picker is
// only a hint the browser applies when it feels like it.
const validationNow = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
function stopTicker() {
	if (ticker !== undefined) clearInterval(ticker);
	ticker = undefined;
}
watch(
	() => props.open,
	(open) => {
		stopTicker();
		if (!open) return;
		validationNow.value = Date.now();
		ticker = setInterval(() => {
			validationNow.value = Date.now();
		}, 15_000);
	},
	{ immediate: true }
);
onBeforeUnmount(stopTicker);

/** `YYYY-MM-DDTHH:mm` in the sender's clock: the picker's floor, this minute. */
const customMin = computed(() => {
	const local = new Date(
		validationNow.value - new Date(validationNow.value).getTimezoneOffset() * 60_000
	);
	return local.toISOString().slice(0, 16);
});

/** The instant the custom value names, or null while the field is empty. */
const customAt = computed<number | null>(() =>
	customDate.value ? new Date(customDate.value).getTime() : null
);
/** A value is there but it is not a time Schedule can use. */
const customInvalid = computed(
	() =>
		customAt.value !== null &&
		(Number.isNaN(customAt.value) || customAt.value <= validationNow.value)
);

/** "Thu, Oct 2, 9:00 AM" in the reader's language, in the given offset's clock. */
function dateTimeAt(at: number, offsetMinutes: number): string {
	return new Intl.DateTimeFormat(locale.value, {
		timeZone: 'UTC',
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(at + offsetMinutes * 60_000));
}

/** The recipient's clock at `at`; carries the weekday when their day differs. */
function recipientClockAt(at: number, senderOffset: number, theirOffset: number): string {
	const sameDay =
		new Date(at + senderOffset * 60_000).getUTCDate() ===
		new Date(at + theirOffset * 60_000).getUTCDate();
	return sameDay
		? clockAt(at, theirOffset)
		: `${weekdayShort(at, theirOffset)} ${clockAt(at, theirOffset)}`;
}
function weekdayShort(at: number, offsetMinutes: number): string {
	return new Intl.DateTimeFormat(locale.value, { timeZone: 'UTC', weekday: 'short' }).format(
		new Date(at + offsetMinutes * 60_000)
	);
}

const customSummary = computed(() => {
	const at = customAt.value;
	const key = 'components.postbox.postboxScheduleDialog';
	if (at === null) return t(`${key}.customZone`, { zone: senderZoneName.value });
	if (customInvalid.value) return t(`${key}.customPast`);
	// The offset AT the chosen instant, so a time past a DST change still
	// reads back as the clock that was typed.
	const senderOffset = -new Date(at).getTimezoneOffset();
	const when = dateTimeAt(at, senderOffset);
	const zone = senderZoneName.value;
	const theirOffset = recipientTimeZone.value
		? zoneOffsetMinutes(recipientTimeZone.value, at)
		: null;
	// Compared at the chosen instant, not at open: two zones that share an
	// offset today can split after a DST change before the send.
	if (theirOffset === null || theirOffset === senderOffset) {
		return t(`${key}.customSends`, { when, zone });
	}
	return t(`${key}.customSendsBoth`, {
		when,
		zone,
		theirs: recipientClockAt(at, senderOffset, theirOffset),
	});
});

function close() {
	emit('update:open', false);
}
function pickPreset(preset: SchedulePreset) {
	emit('confirm', preset.at);
	close();
}
function pickCustom() {
	// Re-read the clock: the minute may have run out since the last tick. An
	// invalid value then shows the error line instead of doing nothing.
	validationNow.value = Date.now();
	const at = customAt.value;
	if (at === null || customInvalid.value) return;
	emit('confirm', at);
	close();
}
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.postboxScheduleDialog.title')"
		size="sm"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<!-- Names the zone the presets are being read against, so "their time"
		     below is never an unattributed claim. -->
		<p
			v-if="showsBothClocks && recipientTimeZone"
			class="text-xs text-text-tertiary mb-2"
			data-testid="postbox-schedule-recipient-zone"
		>
			{{ t('components.postbox.postboxScheduleDialog.recipientZone', { zone: recipientTimeZone }) }}
		</p>
		<ul class="space-y-1 mb-4">
			<li v-for="preset in presets" :key="preset.id">
				<button
					type="button"
					class="w-full flex items-center justify-between gap-3 px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					:data-testid="`postbox-schedule-preset-${preset.id}`"
					@click="pickPreset(preset)"
				>
					<span class="font-medium">{{ presetLabel(preset) }}</span>
					<span class="text-text-tertiary text-right">{{ presetClock(preset) }}</span>
				</button>
			</li>
		</ul>
		<div class="border-t border-border-subtle pt-3">
			<label :for="customInputId" class="text-xs font-medium text-text-tertiary block mb-1">{{
				t('components.postbox.postboxScheduleDialog.custom')
			}}</label>
			<div class="flex items-center gap-2">
				<input
					:id="customInputId"
					v-model="customDate"
					type="datetime-local"
					class="input flex-1"
					:min="customMin"
					:aria-invalid="customInvalid ? 'true' : undefined"
					:aria-describedby="customSummaryId"
					data-testid="postbox-schedule-custom-input"
				/>
				<UiButton
					type="button"
					:disabled="customAt === null || customInvalid"
					data-testid="postbox-schedule-custom-submit"
					@click="pickCustom"
				>
					{{ t('components.postbox.postboxScheduleDialog.schedule') }}
				</UiButton>
			</div>
			<p
				:id="customSummaryId"
				class="text-xs mt-1.5"
				:class="customInvalid ? 'text-error' : 'text-text-tertiary'"
				aria-live="polite"
				data-testid="postbox-schedule-custom-summary"
			>
				{{ customSummary }}
			</p>
		</div>
	</UiModal>
</template>
