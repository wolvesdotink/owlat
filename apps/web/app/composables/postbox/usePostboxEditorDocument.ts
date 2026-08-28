/**
 * Document lifecycle for the Postbox basic editor.
 *
 * Owns the `contenteditable`'s content <-> `modelValue` mirroring: the empty /
 * active-marks derived state, the `<p><br></p>` scaffold, emitting HTML on
 * change, and the incoming `modelValue` watcher (which must let external edits
 * through without clobbering the caret on the parent's echo of our own emit).
 * Lifted out of `PostboxBasicEditor.vue` so that component stays under the
 * file-size ratchet; this is a non-snippet editor concern that reasons about
 * the raw DOM in isolation.
 */
import { onMounted, ref, watch, type Ref } from 'vue';
import {
	EMPTY_ACTIVE_MARKS,
	type ActiveMarks,
} from '@owlat/ui/composables/useRichText';

export function usePostboxEditorDocument(opts: {
	editorRef: Ref<HTMLDivElement | null>;
	/** Current bound HTML (getter so the watcher tracks the live prop). */
	modelValue: () => string;
	/** Reads the caret's active marks from the shared rich-text engine. */
	readActiveMarks: () => ActiveMarks;
	/** Emits the editor's serialized HTML to the parent v-model. */
	emit: (value: string) => void;
}) {
	const isEmpty = ref(true);
	const activeMarks = ref<ActiveMarks>({ ...EMPTY_ACTIVE_MARKS });

	/**
	 * The last HTML this editor emitted upward.
	 *
	 * The parent binds it straight back through `modelValue`, and that echo must
	 * not rewrite the DOM — re-assigning `innerHTML` mid-keystroke would drop the
	 * caret. Suppressing the echo BY VALUE rather than by "is the editor focused"
	 * matters: writers other than the keyboard append to the bound ref (the AI
	 * revise pass, "share as link instead" swapping an attachment for a link
	 * block), and those land at whatever moment their server round-trip resolves.
	 * A focus-based skip drops such a write on the floor, and the next keystroke
	 * emits `el.innerHTML` — which never had it — right over the top of it.
	 */
	let lastEmitted: string | null = null;

	function syncActiveMarks() {
		activeMarks.value = opts.readActiveMarks();
	}

	function syncEmptyState() {
		const el = opts.editorRef.value;
		if (!el) {
			isEmpty.value = true;
			return;
		}
		const text = el.innerText.replace(/​/g, '').trim();
		isEmpty.value = text.length === 0;
	}

	function ensureScaffold() {
		const el = opts.editorRef.value;
		if (!el) return;
		if (el.childNodes.length === 0) {
			el.innerHTML = '<p><br></p>';
		}
	}

	function emitContent() {
		const el = opts.editorRef.value;
		if (!el) return;
		const html = el.innerHTML;
		lastEmitted = html;
		opts.emit(html);
		syncEmptyState();
		syncActiveMarks();
	}

	/**
	 * Drop the caret at the very end of the content after an external rewrite.
	 * Every external writer today appends (a signature, a revise pass, a share
	 * block), so the end is where the user would want to carry on typing; the
	 * alternative — leaving the selection on detached nodes — types into nothing.
	 */
	function placeCaretAtEnd(el: HTMLElement) {
		const selection = window.getSelection?.();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	onMounted(() => {
		const el = opts.editorRef.value;
		if (el) {
			const value = opts.modelValue();
			if (value && el.innerHTML !== value) {
				el.innerHTML = value;
			} else {
				ensureScaffold();
			}
		}
		syncEmptyState();
		syncActiveMarks();
	});

	watch(opts.modelValue, (value) => {
		const el = opts.editorRef.value;
		if (!el) return;
		if (el.innerHTML === value) return;
		// Our own emit coming back around — the DOM is already this value (or has
		// moved past it), so writing it back would only cost the caret.
		if (value === lastEmitted) return;
		// Anything else is a genuinely external edit and has to land even while the
		// user is typing, because nothing will re-deliver it.
		const wasFocused = document.activeElement === el;
		el.innerHTML = value || '';
		ensureScaffold();
		if (wasFocused) placeCaretAtEnd(el);
		syncEmptyState();
	});

	return {
		isEmpty,
		activeMarks,
		syncActiveMarks,
		syncEmptyState,
		ensureScaffold,
		emitContent,
	};
}
