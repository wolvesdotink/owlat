<script setup lang="ts">
import {
	computeSnoozePresets,
	detectSnoozeHint,
	type SnoozePresetKey,
} from '@owlat/shared/snoozePresets';
import type { PresetTimeOption, PresetTimeAction } from './PostboxPresetTimeDialog.vue';

const props = withDefaults(
	defineProps<{
		open: boolean;
		/**
		 * Thread text (subject + snippet) used to infer the suggested wake time.
		 * Deterministic + fail-soft: no match simply shows plain presets.
		 */
		hintText?: string;
	}>(),
	{ hintText: '' }
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
	/** "Snooze until they reply" — carries the fallback cap timestamp. */
	(e: 'confirm-until-reply', capTimestamp: number): void;
}>();

const { t, locale } = useI18n();

/** Fallback cap for "until they reply" — resurface after a week if no reply. */
const UNTIL_REPLY_CAP_MS = 7 * 24 * 60 * 60 * 1000;

// Presets are resolved at open time from the shared, timezone-aware helper so
// the dialog and the backend agree on every wake timestamp. The content hint is
// deterministic; an LLM upgrade (if wired) would just supply a different
// `suggested` key here and still degrade to this on any failure.
//
// `@owlat/shared/snoozePresets` is module scope and shared with the backend, so
// it never speaks: it hands back the catalog KEY for each label (and the key
// plus parameters for each sublabel), and this render boundary is what turns
// those into words — in the active locale, which the wake times and weekdays it
// formats follow too.
const PRESETS = computed<PresetTimeOption[]>(() => {
	const now = Date.now();
	const tzOffsetMinutes = -new Date().getTimezoneOffset();
	const suggested: SnoozePresetKey | null = detectSnoozeHint(props.hintText);
	return computeSnoozePresets({ now, tzOffsetMinutes, suggested, locale: locale.value }).map(
		(p) => ({
			label: t(p.label),
			sub: t(p.sub.key, p.sub.params ?? {}),
			when: () => p.at,
			...(p.suggested ? { suggested: true } : {}),
		})
	);
});

// A computed (not a frozen const) so the labels follow a locale change.
const ACTIONS = computed<PresetTimeAction[]>(() => [
	{
		id: 'until-reply',
		label: t('components.postbox.postboxSnoozeDialog.untilReply'),
		sub: t('components.postbox.postboxSnoozeDialog.untilReplySub'),
	},
]);

function onAction(id: string) {
	if (id === 'until-reply') {
		emit('confirm-until-reply', Date.now() + UNTIL_REPLY_CAP_MS);
	}
}
</script>

<template>
	<PostboxPresetTimeDialog
		:open="open"
		:title="t('components.postbox.postboxSnoozeDialog.title')"
		:presets="PRESETS"
		:actions="ACTIONS"
		:confirm-label="t('components.postbox.postboxSnoozeDialog.confirm')"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm', $event)"
		@action="onAction"
	/>
</template>
