import { ref, watch, nextTick, type Ref } from 'vue';

/**
 * Editor dirty tracking — the load → dirty → save loop shared by the Email
 * editor bridge (useEmailEditorBridge.ts), the campaign form and the template
 * settings page. Pure Vue reactivity, so its correctness is testable without
 * mounting a page.
 *
 * Three states are kept apart: the SERVER BASELINE (every query emission), the
 * LOCAL DRAFT (the tracked refs), and a SUBMISSION (the draft frozen when a save
 * starts). A live query re-emits for reasons that are not the user's — their
 * own save echoing back, a collaborator's write, a send counter — so an
 * emission may replace the draft only when it holds nothing unsaved.
 */

export interface UseEditorDirtyTrackingOptions<S> {
	/** The loaded row; hydrates the draft per entity (see `identity`). */
	source: Ref<S>;
	/** Per-surface parse of the loaded row into the tracked refs. */
	initialize: (source: NonNullable<S>) => void;
	/** Getters for the refs whose deep changes mark the editor dirty. */
	watchSources: (() => unknown)[];
	/** Notified whenever the dirty flag flips (bridges to `setHasChanges`). */
	onDirtyChange?: (dirty: boolean) => void;
	/**
	 * Which entity a row belongs to. A new identity re-hydrates the draft even
	 * over unsaved edits (the editor moved to another entity). Defaults to the
	 * row's `_id`.
	 */
	identity?: (source: NonNullable<S>) => unknown;
	/**
	 * The server's revision of the fields this editor owns. When given, a save
	 * that lands is taken to advance it by exactly one (the backend's guarded
	 * write contract), so the next save names the revision it was built on.
	 */
	revision?: (source: NonNullable<S>) => number;
}

/** A save in flight: the draft as submitted and the server state it was built on. */
export interface EditorSubmission<S> {
	/** Serialized tracked refs at submit time. */
	readonly draft: string;
	/** The row the draft was hydrated from (or acknowledged against). */
	readonly base: NonNullable<S> | null;
	/** `revision(base)` — the revision the save must still find on the server. */
	readonly revision: number | undefined;
	/** Hydration generation, so a mid-save re-hydration wins over the ack. */
	readonly generation: number;
}

export interface UseEditorDirtyTrackingReturn<S> {
	hasChanges: Ref<boolean>;
	isInitialized: Ref<boolean>;
	/** Freeze the draft at the start of a save. */
	beginSubmit: () => EditorSubmission<S>;
	/**
	 * The save of `submission` landed. Clears dirty only when the draft still
	 * equals what was submitted; an edit made while the save was in flight keeps
	 * the editor dirty.
	 */
	acknowledge: (submission: EditorSubmission<S>) => void;
	/** Unconditionally clean, catching the draft up to the latest server row. */
	markClean: () => void;
}

const defaultIdentity = (source: unknown): unknown =>
	typeof source === 'object' && source !== null && '_id' in source
		? (source as { _id: unknown })._id
		: undefined;

export function useEditorDirtyTracking<S>(
	opts: UseEditorDirtyTrackingOptions<S>
): UseEditorDirtyTrackingReturn<S> {
	const hasChanges = ref(false);
	const isInitialized = ref(false);
	const identityOf = opts.identity ?? defaultIdentity;

	// The latest emission (server baseline) and the row the draft was last
	// hydrated from; `base` is the row whose revision the draft is built on.
	let latest: NonNullable<S> | null = null;
	let hydratedFrom: NonNullable<S> | null = null;
	let base: NonNullable<S> | null = null;
	let baseRevision: number | undefined;
	let hydratedIdentity: unknown;
	let generation = 0;
	// Hydration writes the tracked refs; suppress the change watcher until the
	// flush those writes queue has run.
	let hydrating = false;

	const setDirty = (dirty: boolean) => {
		hasChanges.value = dirty;
		opts.onDirtyChange?.(dirty);
	};

	const serializeDraft = () => JSON.stringify(opts.watchSources.map((read) => read()));

	const hydrate = (row: NonNullable<S>) => {
		hydrating = true;
		generation += 1;
		hydratedFrom = row;
		base = row;
		baseRevision = opts.revision?.(row);
		hydratedIdentity = identityOf(row);
		opts.initialize(row);
		setDirty(false);
		void nextTick(() => {
			hydrating = false;
			isInitialized.value = true;
		});
	};

	watch(
		opts.source,
		(row) => {
			if (!row) return;
			latest = row;
			if (hydratedFrom === null || identityOf(row) !== hydratedIdentity) {
				hydrate(row);
				return;
			}
			if (!hasChanges.value) {
				// Nothing unsaved: follow the server.
				hydrate(row);
				return;
			}
			// Unsaved draft: keep it. A row at the draft's revision (a send
			// counter, a schema tweak) is still a valid base for it; anything
			// newer is a write the next save has to be checked against.
			if (opts.revision === undefined || opts.revision(row) === baseRevision) base = row;
		},
		{ immediate: true }
	);

	watch(
		opts.watchSources,
		() => {
			// Only track changes after the initial data has been loaded, and not
			// the writes a hydration makes.
			if (!isInitialized.value || hydrating) return;
			setDirty(true);
		},
		{ deep: true }
	);

	const beginSubmit = (): EditorSubmission<S> => ({
		draft: serializeDraft(),
		base,
		revision: baseRevision,
		generation,
	});

	const catchUp = () => {
		// An emission skipped while the draft was dirty (e.g. a settings save
		// that re-keys the row) is applied now that nothing is unsaved.
		if (latest !== null && latest !== hydratedFrom && identityOf(latest) === hydratedIdentity) {
			hydrate(latest);
		} else {
			setDirty(false);
		}
	};

	const acknowledge = (submission: EditorSubmission<S>) => {
		// Re-hydrated while the save was in flight (clean draft followed the
		// server, or the editor moved to another entity): that state wins.
		if (submission.generation !== generation) return;
		if (submission.revision !== undefined) {
			// Our write landed as the next revision; the draft now builds on it.
			baseRevision = submission.revision + 1;
			if (latest !== null && opts.revision?.(latest) === baseRevision) base = latest;
		} else if (opts.revision === undefined && latest !== null) {
			base = latest;
		}
		if (serializeDraft() === submission.draft) catchUp();
	};

	return {
		hasChanges,
		isInitialized,
		beginSubmit,
		acknowledge,
		markClean: catchUp,
	};
}
