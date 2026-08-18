/**
 * The Postbox inbox's two mode switches and their keyboard chords, split out of
 * PostboxLayout.vue (which owns the panes) to keep that file under the
 * file-size cap.
 *
 *   - `viewMode` — which of the three list renderers is active (Flat /
 *     Conversations / Categories). Inbox-only; every other folder renders flat.
 *   - `inboxMode` — which surface the inbox route lands on: 'today' (the
 *     focused single column) or 'browse' (the three panes).
 *
 * Both are persisted per user on the server (usePostboxSettings, passed in by
 * the layout so the settings query stays a single subscription there). A tap
 * applies immediately as a pending optimistic override and hands back to the
 * saved value once the mutation lands — or snaps back if it failed.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import {
	POSTBOX_VIEW_MODE_OPTIONS,
	postboxListRenderer,
	resolvePostboxViewMode,
} from '~/utils/postboxViewMode';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { isEditableTarget } from '~/utils/postboxShortcuts';

interface PostboxInboxModesOptions {
	folderRole: Ref<string>;
	folderId: Ref<Id<'mailFolders'> | undefined>;
	activeMessageId: Ref<string | null | undefined>;
	/** The mobile folder drawer's own state — it owns Esc while it is open. */
	railOpen: Ref<boolean>;
	savedViewMode: Ref<PostboxViewMode>;
	setViewMode: (mode: PostboxViewMode) => Promise<boolean>;
	savedInboxMode: Ref<PostboxInboxMode>;
	setInboxMode: (mode: PostboxInboxMode) => Promise<boolean>;
}

export function usePostboxInboxModes(options: PostboxInboxModesOptions) {
	const { folderRole, folderId, activeMessageId, railOpen } = options;
	const { t } = useI18n();

	// Inbox view mode — exactly one of Flat / Conversations / Categories is
	// active. The saved (server-persisted) value drives the list; a pending
	// optimistic override reflects a tap immediately while the mutation lands,
	// then hands back to the server value. Grouped renderers are inbox-only; the
	// flat list with its hover/keyboard triage serves all other folders.
	const pendingViewMode = ref<PostboxViewMode | null>(null);
	const viewMode = computed<PostboxViewMode>(
		() => pendingViewMode.value ?? options.savedViewMode.value
	);
	watch(options.savedViewMode, (saved) => {
		if (pendingViewMode.value === saved) pendingViewMode.value = null;
	});
	function selectViewMode(value: string) {
		const mode = resolvePostboxViewMode(value);
		if (mode === viewMode.value) return;
		pendingViewMode.value = mode;
		// The list already switched optimistically; useBackendOperation surfaces a
		// toast if the save fails, and the override snaps back to the saved mode.
		void options.setViewMode(mode).then((saved) => {
			if (!saved && pendingViewMode.value === mode) pendingViewMode.value = null;
		});
	}
	const activeListRenderer = computed(() => postboxListRenderer(viewMode.value, folderRole.value));
	// The mode registry stays a plain module-scope constant (non-UI code reads it
	// too); its segment labels are localized here, where they are rendered.
	const viewModeOptions = computed(() =>
		POSTBOX_VIEW_MODE_OPTIONS.map(({ value }) => ({
			value,
			label: t(`components.postbox.postboxLayout.viewModes.${value}`),
		}))
	);

	// Inbox landing mode — 'today' (the focused single-column PostboxTodayView;
	// the default) vs 'browse' (the three panes). Inbox-only: every other folder
	// keeps the three-pane UI regardless of mode. A deep-linked message
	// (/inbox/<id>) stays in Today mode too — the Today view opens it in its
	// centered reader overlay over the list; in browse mode the same route is
	// the unchanged three-pane reader. Same optimistic-override pattern as the
	// view mode above; the server remembers the last-used mode.
	const pendingInboxMode = ref<PostboxInboxMode | null>(null);
	const inboxMode = computed<PostboxInboxMode>(
		() => pendingInboxMode.value ?? options.savedInboxMode.value
	);
	watch(options.savedInboxMode, (saved) => {
		if (pendingInboxMode.value === saved) pendingInboxMode.value = null;
	});
	function switchInboxMode(mode: PostboxInboxMode) {
		if (mode === inboxMode.value) return;
		pendingInboxMode.value = mode;
		void options.setInboxMode(mode).then((saved) => {
			if (!saved && pendingInboxMode.value === mode) pendingInboxMode.value = null;
		});
	}
	const todayActive = computed(
		() => folderRole.value === 'inbox' && !folderId.value && inboxMode.value === 'today'
	);

	// The Today roll-up line's "view" opens the auto-filed mail where it lives:
	// browse mode with the Categories renderer. The Categories choice is a
	// TRANSIENT override (pendingViewMode) — it must not silently overwrite the
	// user's saved list preference.
	function viewAutoFiled() {
		pendingViewMode.value = 'categories';
		switchInboxMode('browse');
	}

	// Focus the rail's search box after a mode flip mounts it (the `/` shortcut
	// from Today mode; the rail consumes + clears the flag on mount).
	const searchAutofocus = useState('postbox:search-autofocus', () => false);

	// Mode shortcuts (window-level, like the layout's triage-undo chord): B (and
	// Cmd/Ctrl-B) toggles Today ↔ Browse from the inbox list; Esc returns from
	// Browse to Today; `/` from Today jumps to Browse with the search focused
	// (search never renders inside the Today column). All inert in text inputs,
	// while a message is open, and while any dialog is up.
	function onModeKeydown(event: KeyboardEvent) {
		// The mobile folder drawer owns Esc while it is open.
		if (event.key === 'Escape' && railOpen.value) {
			railOpen.value = false;
			return;
		}
		if (folderRole.value !== 'inbox' || folderId.value || activeMessageId.value) return;
		if (isEditableTarget(event.target)) return;
		if (event.defaultPrevented) return;
		if (document.querySelector('[role="dialog"]')) return;
		if (event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			switchInboxMode(inboxMode.value === 'today' ? 'browse' : 'today');
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Escape' && inboxMode.value === 'browse') {
			switchInboxMode('today');
			return;
		}
		if (event.key === '/' && todayActive.value) {
			event.preventDefault();
			searchAutofocus.value = true;
			switchInboxMode('browse');
		}
	}
	onMounted(() => window.addEventListener('keydown', onModeKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', onModeKeydown));

	return {
		viewMode,
		viewModeOptions,
		selectViewMode,
		activeListRenderer,
		inboxMode,
		switchInboxMode,
		todayActive,
		viewAutoFiled,
	};
}
