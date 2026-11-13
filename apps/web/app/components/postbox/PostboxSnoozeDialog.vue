<script setup lang="ts">
import {
	POSTBOX_SNOOZE_SCOPE_DEFAULT,
	POSTBOX_SNOOZE_SCOPE_OPTIONS,
	resolvePostboxSnoozeScope,
	type PostboxSnoozeScope,
} from '~/utils/postboxSnoozeScope';
import type { PresetTimeOption, PresetTimeAction } from './PostboxPresetTimeDialog.vue';
import {
	SNOOZE_UNTIL_REPLY_CAP_MS,
	usePostboxSnoozePresets,
} from '~/composables/postbox/usePostboxSnoozePresets';

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

const { t } = useI18n();
const { presets } = usePostboxSnoozePresets();

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

const scopeOptions = computed(() =>
	POSTBOX_SNOOZE_SCOPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))
);
const scopeModel = computed({
	get: () => scope.value,
	set: (value: string) => {
		scope.value = resolvePostboxSnoozeScope(value);
	},
});

// Presets are resolved at open time from the shared, timezone-aware helper so
// the dialog and the backend agree on every wake timestamp. The content hint is
// deterministic; an LLM upgrade (if wired) would just supply a different
// `suggested` key and still degrade to this on any failure.
const PRESETS = computed<PresetTimeOption[]>(() =>
	presets(props.hintText).map((p) => ({
		label: p.label,
		sub: p.sub,
		when: () => p.at,
		...(p.suggested ? { suggested: true } : {}),
	}))
);

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
		emit('confirm-until-reply', Date.now() + SNOOZE_UNTIL_REPLY_CAP_MS);
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
			<UiSegmentedControl
				v-model="scopeModel"
				class="mb-3"
				size="sm"
				fit="content"
				:options="scopeOptions"
				:aria-label="t('components.postbox.postboxSnoozeDialog.scopeLabel')"
			/>
		</template>
	</PostboxPresetTimeDialog>
</template>
