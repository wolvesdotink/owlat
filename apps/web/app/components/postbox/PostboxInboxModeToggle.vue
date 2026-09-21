<script setup lang="ts">
/**
 * The inbox's Today | Browse switch — one control, mounted on the Inbox title
 * of BOTH landing surfaces.
 *
 * It replaces two one-way buttons that could never tell you where you were: a
 * "Today" jump in the browse list header and a "Browse" button that only
 * existed inside the Today view. Two exits, no state. As a two-segment control
 * the active surface is now visible from either side, which is what the pair
 * always described.
 *
 * The keyboard is untouched: `postbox.toggleBrowse` (B), Cmd/Ctrl-B and Esc are
 * still handled window-level in usePostboxInboxModes, and `aria-keyshortcuts`
 * on the control says so.
 */
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';

defineProps<{
	/** Which surface is on screen. */
	mode: PostboxInboxMode;
}>();

const emit = defineEmits<{
	select: [value: PostboxInboxMode];
}>();

const { t } = useI18n();

const options = computed(() => [
	{ value: 'today', label: t('common.today') },
	{ value: 'browse', label: t('components.postbox.postboxTodayView.browse') },
]);
</script>

<template>
	<UiSegmentedControl
		size="sm"
		aria-keyshortcuts="b Escape"
		:aria-label="t('components.postbox.postboxInboxModeToggle.label')"
		:title="t('components.postbox.postboxInboxModeToggle.title')"
		:options="options"
		:model-value="mode"
		@update:model-value="emit('select', $event === 'browse' ? 'browse' : 'today')"
	/>
</template>
