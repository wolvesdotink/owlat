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

const customDate = ref('');

function close() {
	emit('update:open', false);
}
function pickPreset(preset: SchedulePreset) {
	emit('confirm', preset.at);
	close();
}
function pickCustom() {
	if (!customDate.value) return;
	const ts = new Date(customDate.value).getTime();
	if (Number.isNaN(ts) || ts <= Date.now()) return;
	emit('confirm', ts);
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
			<label class="text-xs font-medium text-text-tertiary block mb-1">{{
				t('components.postbox.postboxScheduleDialog.custom')
			}}</label>
			<div class="flex items-center gap-2">
				<input v-model="customDate" type="datetime-local" class="input flex-1" />
				<UiButton type="button" :disabled="!customDate" @click="pickCustom">
					{{ t('components.postbox.postboxScheduleDialog.schedule') }}
				</UiButton>
			</div>
		</div>
	</UiModal>
</template>
