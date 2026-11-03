/**
 * The saved-reply affordances both composers share, beside the `;` trigger in
 * the text: the footer's picker (its button and ⌘; / Ctrl+;), "Save as reply",
 * and the command palette's saved-reply group while this composer has focus.
 *
 * "Has focus" survives the palette itself: opening ⌘K moves focus into the
 * palette's dialog, and a composer losing focus to a dialog stays the active
 * one, so the palette's rows insert where the person was typing. Focus moving
 * anywhere else in the page hands the palette back to everything else.
 *
 * The composer supplies how a reply goes in (`insert`); the Postbox editor
 * writes at its caret, the Team inbox reply into its textarea.
 *
 * "Save as reply" keeps the text selected in the composer when there is a
 * selection, and everything written otherwise. The selection is read as it
 * changes, because opening the picker or the palette moves the page's
 * selection into their search field; it is dropped with the composer's focus.
 */

import type { ComputedRef, Ref } from 'vue';
import {
	SAVED_REPLY_COMMAND_PROVIDER_ID_PREFIX,
	SAVED_REPLY_COMMAND_PROVIDER_PRIORITY,
	buildSavedReplyGroups,
} from '~/lib/commandPaletteSurfaces';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';
import { rankSnippets } from '~/utils/postboxSnippets';
import { aiTextToHtml } from '~/utils/answerDraft';
import { htmlToPlainText } from '@owlat/shared/html';
import { chordFromEvent } from '~/utils/shortcutRegistry';

/** Opens (and closes) the composer's saved-reply picker. */
export const SAVED_REPLIES_CHORD = 'mod+;';

/** What the composer footer renders the saved-reply button and its dialogs from. */
export interface ComposerSavedReplies {
	/** The replies this composer may insert right now (none while it cannot insert). */
	replies: ComputedRef<EditorSnippet[]>;
	/** The composer can take a reply (the Postbox's simple editor, a loaded body). */
	enabled: ComputedRef<boolean>;
	/** What "Save as reply" keeps, as HTML: the selection, or all that was written. */
	currentBodyHtml: ComputedRef<string>;
	/** "Save as reply" keeps a selection rather than all that was written. */
	savesSelection: ComputedRef<boolean>;
	pickerOpen: Ref<boolean>;
	saveOpen: Ref<boolean>;
	pick: (reply: EditorSnippet) => void;
	handleKeydown: (event: KeyboardEvent) => boolean;
}

export function useComposerSavedReplyPicker(opts: {
	rootEl: Ref<HTMLElement | null>;
	replies: Ref<EditorSnippet[]>;
	enabled: () => boolean;
	currentBodyHtml: () => string;
	insert: (reply: EditorSnippet) => void;
}): ComposerSavedReplies {
	const { t } = useI18n();
	const pickerOpen = ref(false);
	const saveOpen = ref(false);
	const enabled = computed(() => opts.enabled());
	const replies = computed(() => (enabled.value ? opts.replies.value : []));

	const instance = useId();
	const active = useState<string | null>('savedReplies:activeComposer', () => null);

	/**
	 * The text selected in this composer, as HTML: '' when nothing is, null
	 * when the page's selection is somewhere else (which says nothing about
	 * this composer). A textarea keeps its own selection range.
	 */
	function readSelection(): string | null {
		const root = opts.rootEl.value;
		if (!root) return null;
		const focused = document.activeElement;
		if (focused instanceof HTMLTextAreaElement && root.contains(focused)) {
			const text = focused.value.slice(focused.selectionStart, focused.selectionEnd);
			return text.trim() ? aiTextToHtml(text) : '';
		}
		const selection = document.getSelection();
		if (!selection || selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);
		const node = range.commonAncestorContainer;
		const editor = (node instanceof Element ? node : node.parentElement)?.closest(
			'[contenteditable="true"]'
		);
		if (!editor || !root.contains(editor)) return null;
		if (selection.isCollapsed) return '';
		const box = document.createElement('div');
		box.append(range.cloneContents());
		return box.innerHTML;
	}
	const selectedHtml = ref('');
	function onSelectionChange() {
		const next = readSelection();
		if (next !== null) selectedHtml.value = next;
	}
	onMounted(() => document.addEventListener('selectionchange', onSelectionChange));
	const savesSelection = computed(() => htmlToPlainText(selectedHtml.value).trim().length > 0);

	function onFocusIn() {
		active.value = instance;
	}
	function onFocusOut(event: FocusEvent) {
		const next = event.relatedTarget;
		// Focus leaving the window, or moving into a dialog (the palette, the
		// picker's own prompt) keeps this composer the one being written in.
		if (!(next instanceof Node)) return;
		if (opts.rootEl.value?.contains(next)) return;
		if (next instanceof Element && next.closest('[role="dialog"]')) return;
		if (active.value === instance) active.value = null;
		selectedHtml.value = '';
	}
	watch(
		opts.rootEl,
		(el, previous) => {
			previous?.removeEventListener('focusin', onFocusIn);
			previous?.removeEventListener('focusout', onFocusOut);
			el?.addEventListener('focusin', onFocusIn);
			el?.addEventListener('focusout', onFocusOut);
		},
		{ immediate: true }
	);
	onBeforeUnmount(() => {
		document.removeEventListener('selectionchange', onSelectionChange);
		opts.rootEl.value?.removeEventListener('focusin', onFocusIn);
		opts.rootEl.value?.removeEventListener('focusout', onFocusOut);
		if (active.value === instance) active.value = null;
	});

	function pick(reply: EditorSnippet) {
		pickerOpen.value = false;
		opts.insert(reply);
	}

	/** ⌘; / Ctrl+; toggles the picker. True when the key was consumed. */
	function handleKeydown(event: KeyboardEvent): boolean {
		if (!enabled.value || chordFromEvent(event) !== SAVED_REPLIES_CHORD) return false;
		event.preventDefault();
		event.stopPropagation();
		pickerOpen.value = !pickerOpen.value;
		return true;
	}

	registerCommandPaletteProvider({
		id: `${SAVED_REPLY_COMMAND_PROVIDER_ID_PREFIX}:${instance}`,
		priority: SAVED_REPLY_COMMAND_PROVIDER_PRIORITY,
		build: ({ query }) => {
			if (active.value !== instance || !enabled.value) return [];
			const ordered = rankSnippets(replies.value, '');
			return buildSavedReplyGroups(
				{
					replies: () => ordered,
					t,
					// After the palette has closed and handed focus back.
					onInsert: (id) => {
						const reply = ordered.find((r) => r._id === id);
						if (reply) window.setTimeout(() => opts.insert(reply), 0);
					},
					onSaveCurrent: () => {
						saveOpen.value = true;
					},
				},
				query
			);
		},
	});

	return {
		replies,
		enabled,
		currentBodyHtml: computed(() =>
			savesSelection.value ? selectedHtml.value : opts.currentBodyHtml()
		),
		savesSelection,
		pickerOpen,
		saveOpen,
		pick,
		handleKeydown,
	};
}
