<script setup lang="ts">
/**
 * The inbox's Priority | All mail switch — one control, mounted on the Inbox
 * title of BOTH landing surfaces. The modes are stored as 'today' and
 * 'browse', but the labels say Priority and All mail, so "Today" names the
 * home page and nothing else.
 *
 * It replaces two one-way buttons that could never tell you where you were: a
 * "Today" jump in the browse list header and a "Browse" button that only
 * existed inside the Today view. Two exits, no state. As a two-segment control
 * the active surface is now visible from either side, which is what the pair
 * always described.
 *
 * Its first segment, People, leaves the classic inbox for the People view (the
 * same setting as Preferences → Reading), so the way back is where the
 * person is, not only in Settings.
 *
 * The keyboard is untouched: `postbox.toggleBrowse` (B), Cmd/Ctrl-B and Esc are
 * still handled window-level in usePostboxInboxModes, and `aria-keyshortcuts`
 * on the control says so.
 */
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

defineProps<{
	/** Which surface is on screen. */
	mode: PostboxInboxMode;
}>();

const emit = defineEmits<{
	select: [value: PostboxInboxMode];
}>();

const { t } = useI18n();
const { ariaFor, chordAria } = useShortcutLabels();

// The B key follows the preset (Gmail's frees it), Cmd/Ctrl-B is fixed.
const keyShortcuts = computed(() =>
	[ariaFor('postbox.toggleBrowse'), chordAria('mod+b'), 'Escape'].filter(Boolean).join(' ')
);

const { setClassicInbox } = usePostboxClassicInbox();
const options = computed(() => [
	{ value: 'people', label: t('components.postbox.postboxInboxModeToggle.people') },
	{ value: 'today', label: t('components.postbox.postboxInboxModeToggle.priority') },
	{ value: 'browse', label: t('components.postbox.postboxInboxModeToggle.all') },
]);
const route = useRoute();
const router = useRouter();
function onSelect(value: string) {
	if (value !== 'people') {
		emit('select', value === 'browse' ? 'browse' : 'today');
		return;
	}
	void setClassicInbox(false);
	// A filtered list (`?placement=`) is a classic view of its own: People only
	// shows once the filter is gone too.
	if (route.query['placement'] !== undefined) {
		const { placement: _placement, ...rest } = route.query;
		void router.replace({ query: rest });
	}
}
</script>

<template>
	<UiTooltip :text="t('components.postbox.postboxInboxModeToggle.title')">
		<template #shortcut><UiShortcut id="postbox.toggleBrowse" /></template>
		<UiSegmentedControl
			size="sm"
			:aria-keyshortcuts="keyShortcuts"
			:aria-label="t('components.postbox.postboxInboxModeToggle.label')"
			:options="options"
			:model-value="mode"
			fit="content"
			@update:model-value="onSelect"
		/>
	</UiTooltip>
</template>
