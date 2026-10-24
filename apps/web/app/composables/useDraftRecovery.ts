import { shallowRef, watch, type Ref } from 'vue';
import {
	getEditorDraftStore,
	type EditorDraftCopy,
	type EditorDraftStore,
	type FoundEditorDraft,
} from '~/utils/editorDraftStore';
import { getEditorDraftWriters, type EditorDraftWriters } from '~/utils/editorDraftWriters';

/**
 * Draft recovery: what an editor does with the device copies
 * (`useDraftAutosave.ts`) of edits that never reached the server — written
 * offline, or left behind by an editor that closed before its save landed.
 *
 * Checked once per draft, after the editor has loaded what the server holds.
 * A copy whose editor is still open (another tab) is that editor's and left
 * alone (`editorDraftWriters.ts`). Of the others:
 * - a copy equal to what the editor shows is stale and deleted;
 * - the newest other copy is applied when the surface can apply it safely
 *   (`canApply`: built on the state the server still holds) and nothing was
 *   edited here while the copies were read; the editor's autosave saves it;
 * - otherwise it is offered (`pending`), never applied over newer work
 *   without the person choosing it.
 * A copy that was applied becomes this editor's: once its own copy is on the
 * device (`keep`), the one left behind is deleted.
 */

export interface DraftRecoveryOptions<T> {
	/** The draft's device copies (`editorDraftScope`); null while there are none. */
	scope: () => string | null;
	/** The editor has loaded the server's state (and may be compared). */
	ready: () => boolean;
	/** Counts the editor's own edits; one during the read rules out applying. */
	edits?: () => number;
	/** Shape check for stored data (it comes from an older build, maybe). */
	accept: (data: unknown) => data is T;
	/** Whether the copy says the same as the editor does now. */
	matches: (data: T) => boolean;
	/** Whether the copy can be applied without asking. */
	canApply: (copy: EditorDraftCopy<T>) => boolean;
	/** Put the copy into the editor (an edit like any other). */
	apply: (data: T) => void;
	/**
	 * After `apply`: write the editor's own device copy; resolves whether it
	 * holds the applied draft. Default: nothing to wait for.
	 */
	keep?: () => Promise<boolean>;
	/** Told after a copy was applied without asking (a toast). */
	onApplied?: (copy: EditorDraftCopy<T>) => void;
	store?: EditorDraftStore;
	writers?: EditorDraftWriters;
}

export interface DraftRecovery<T> {
	/** A copy waiting for the person's choice. */
	pending: Readonly<Ref<EditorDraftCopy<T> | null>>;
	restore: () => void;
	discard: () => void;
}

export function useDraftRecovery<T>(opts: DraftRecoveryOptions<T>): DraftRecovery<T> {
	const store = opts.store ?? getEditorDraftStore();
	const writers = opts.writers ?? getEditorDraftWriters();
	const pending = shallowRef<EditorDraftCopy<T> | null>(null);
	let offered: { scope: string; found: FoundEditorDraft<T> } | null = null;
	let checkedScope: string | null = null;

	/** Apply a copy; the one left behind goes once the editor kept its own. */
	const adopt = async (found: FoundEditorDraft<T>) => {
		opts.apply(found.copy.data);
		if (opts.keep && !(await opts.keep())) return;
		await store.removeIf(found.key, found.copy.savedAt);
	};

	const check = async (scope: string) => {
		checkedScope = scope;
		const editsBefore = opts.edits?.();
		const [copies, isOpen] = await Promise.all([
			store.list(scope, opts.accept),
			writers.liveness(),
		]);
		let offer: FoundEditorDraft<T> | null = null;
		for (const found of copies) {
			// The editor moved to another draft while the copies were read.
			if (checkedScope !== scope || opts.scope() !== scope) return;
			if (isOpen(found.writerId)) continue;
			if (opts.matches(found.copy.data)) await store.removeIf(found.key, found.copy.savedAt);
			else offer ??= found;
		}
		if (!offer || checkedScope !== scope || opts.scope() !== scope) return;
		if (opts.edits?.() === editsBefore && opts.canApply(offer.copy)) {
			opts.onApplied?.(offer.copy);
			await adopt(offer);
		} else {
			pending.value = offer.copy;
			offered = { scope, found: offer };
		}
	};

	watch(
		() => (opts.ready() ? opts.scope() : null),
		(scope) => {
			if (scope === null || scope === checkedScope) return;
			pending.value = null;
			offered = null;
			void check(scope);
		},
		{ immediate: true }
	);

	const take = () => {
		const choice = offered;
		pending.value = null;
		offered = null;
		return choice;
	};

	return {
		pending,
		restore: () => {
			const choice = take();
			if (choice && choice.scope === opts.scope()) void adopt(choice.found);
		},
		discard: () => {
			const choice = take();
			if (choice) void store.removeIf(choice.found.key, choice.found.copy.savedAt);
		},
	};
}
