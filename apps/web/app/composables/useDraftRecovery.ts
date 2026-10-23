import { shallowRef, watch, type Ref } from 'vue';
import {
	getEditorDraftStore,
	type EditorDraftCopy,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';

/**
 * Draft recovery: what an editor does with the device copy
 * (`useDraftAutosave.ts`) of edits that never reached the server — written
 * offline, or left behind by a tab that closed before its save landed.
 *
 * Checked once per draft, after the editor has loaded what the server holds:
 * - a copy equal to that is stale and deleted;
 * - a copy the surface can apply safely (`canApply`: built on the state the
 *   server still holds) is applied, and the editor's autosave saves it;
 * - any other copy (the server moved on since) is offered (`pending`), never
 *   applied over the newer state without the person choosing it.
 */

export interface DraftRecoveryOptions<T> {
	/** The device copy's key; null while there is none. */
	key: () => string | null;
	/** The editor has loaded the server's state (and may be compared). */
	ready: () => boolean;
	/** Shape check for stored data (it comes from an older build, maybe). */
	accept: (data: unknown) => data is T;
	/** Whether the copy says the same as the editor does now. */
	matches: (data: T) => boolean;
	/** Whether the copy can be applied without asking. */
	canApply: (copy: EditorDraftCopy<T>) => boolean;
	/** Put the copy into the editor (an edit like any other). */
	apply: (data: T) => void;
	/** Told after a copy was applied without asking (a toast). */
	onApplied?: (copy: EditorDraftCopy<T>) => void;
	store?: EditorDraftStore;
}

export interface DraftRecovery<T> {
	/** A copy waiting for the person's choice. */
	pending: Readonly<Ref<EditorDraftCopy<T> | null>>;
	restore: () => void;
	discard: () => void;
}

export function useDraftRecovery<T>(opts: DraftRecoveryOptions<T>): DraftRecovery<T> {
	const store = opts.store ?? getEditorDraftStore();
	const pending = shallowRef<EditorDraftCopy<T> | null>(null);
	let pendingKey: string | null = null;
	let checkedKey: string | null = null;

	const check = async (key: string) => {
		checkedKey = key;
		const copy = await store.read(key, opts.accept);
		// The editor moved to another draft while the copy was read.
		if (!copy || checkedKey !== key || opts.key() !== key) return;
		if (opts.matches(copy.data)) {
			await store.removeIf(key, copy.savedAt);
		} else if (opts.canApply(copy)) {
			opts.apply(copy.data);
			opts.onApplied?.(copy);
		} else {
			pending.value = copy;
			pendingKey = key;
		}
	};

	watch(
		() => (opts.ready() ? opts.key() : null),
		(key) => {
			if (key === null || key === checkedKey) return;
			pending.value = null;
			pendingKey = null;
			void check(key);
		},
		{ immediate: true }
	);

	return {
		pending,
		restore: () => {
			const copy = pending.value;
			pending.value = null;
			if (copy && pendingKey === opts.key()) opts.apply(copy.data);
		},
		discard: () => {
			const copy = pending.value;
			const key = pendingKey;
			pending.value = null;
			if (copy && key) void store.removeIf(key, copy.savedAt);
		},
	};
}
