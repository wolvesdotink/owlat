/**
 * Document lifecycle for the Postbox basic editor.
 *
 * Owns the `contenteditable`'s content <-> `modelValue` mirroring: the empty /
 * active-marks derived state, the `<p><br></p>` scaffold, emitting HTML on
 * change, and the incoming `modelValue` watcher (which must never clobber the
 * caret mid-typing). Lifted out of `PostboxBasicEditor.vue` so that component
 * stays under the file-size ratchet; this is a non-snippet editor concern that
 * reasons about the raw DOM in isolation.
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
		opts.emit(el.innerHTML);
		syncEmptyState();
		syncActiveMarks();
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
		// Don't clobber the user's cursor mid-typing.
		if (document.activeElement === el) return;
		el.innerHTML = value || '';
		ensureScaffold();
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
