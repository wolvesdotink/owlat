<script setup lang="ts">
import {
	computeSnoozePresets,
	detectSnoozeHint,
	type SnoozePresetKey,
} from '@owlat/shared/snoozePresets';
import {
	POSTBOX_SNOOZE_SCOPE_DEFAULT,
	POSTBOX_SNOOZE_SCOPE_OPTIONS,
	type PostboxSnoozeScope,
} from '~/utils/postboxSnoozeScope';
import type { PresetTimeOption, PresetTimeAction } from './PostboxPresetTimeDialog.vue';

const props = withDefaults(
	defineProps<{
		open: boolean;
		/**
		 * Thread text (subject + snippet) used to infer the suggested wake time.
		 * Deterministic + fail-soft: no match simply shows plain presets.
		 */
		hintText?: string;
		/**
		 * Offer the thread/message scope toggle. Hosts that can address a whole
		 * conversation (the list row, the reader) set this; the bulk-selection bar
		 * leaves it off, because "selection" is already the scope there.
		 */
		scoped?: boolean;
	}>(),
	{ hintText: '', scoped: false }
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	/**
	 * A wake time was picked. `scope` says whether the caller should defer the
	 * whole conversation ('thread', the default) or only the addressed message.
	 * Hosts that never set `scoped` can ignore the second argument entirely.
	 */
	(e: 'confirm', timestamp: number, scope: PostboxSnoozeScope): void;
	/** "Snooze until they reply" — carries the fallback cap timestamp. */
	(e: 'confirm-until-reply', capTimestamp: number): void;
}>();

const { t, locale } = useI18n();

/** Fallback cap for "until they reply" — resurface after a week if no reply. */
const UNTIL_REPLY_CAP_MS = 7 * 24 * 60 * 60 * 1000;

// Scope defaults to the whole conversation every time the dialog opens: a
// per-session memory would make `h` mean different things on different days,
// which is the one thing a single-key verb can't afford.
const scope = ref<PostboxSnoozeScope>(POSTBOX_SNOOZE_SCOPE_DEFAULT);
watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) scope.value = POSTBOX_SNOOZE_SCOPE_DEFAULT;
	}
);

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
		@confirm="(timestamp: number) => emit('confirm', timestamp, scope)"
		@action="onAction"
	>
		<template v-if="scoped" #beforePresets>
			<div
				class="mb-3 inline-flex rounded border border-border-subtle p-0.5"
				role="radiogroup"
				:aria-label="t('components.postbox.postboxSnoozeDialog.scopeLabel')"
			>
				<button
					v-for="option in POSTBOX_SNOOZE_SCOPE_OPTIONS"
					:key="option.value"
					type="button"
					role="radio"
					:aria-checked="scope === option.value"
					class="px-2.5 py-1 rounded text-xs font-medium"
					:class="
						scope === option.value
							? 'bg-brand text-text-inverse'
							: 'text-text-tertiary hover:text-text-primary'
					"
					@click="scope = option.value"
				>
					{{ t(option.label) }}
				</button>
			</div>
		</template>
	</PostboxPresetTimeDialog>
</template>
