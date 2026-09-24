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
	 * The server's revision of the fields this editor owns. When given, the
	 * next save names the revision its draft was built on: the one the write
	 * that landed reported (see `acknowledge`), or a hydrated row's.
	 */
	revision?: (source: NonNullable<S>) => number;
	/**
	 * Called after every hydration, once `initialize` has written the tracked
	 * refs. A host whose refs feed a component with its own copy of the state
	 * (the email builder's canvas) pushes the hydrated state through here.
	 */
	onHydrate?: (source: NonNullable<S>) => void;
	/**
	 * Unsaved work the tracked refs cannot see yet (an open inline text editor
	 * commits only when it closes). While this returns true, an emission is
	 * treated as if the draft were dirty: the draft and its base revision are
	 * kept, so work committed later is saved against the revision it started
	 * from and a write that landed meanwhile surfaces as a conflict. Once it
	 * turns false with nothing committed, the editor catches up.
	 */
	holdHydration?: () => boolean;
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
	 * The save of `submission` landed, as `landedRevision` when the write
	 * reported one (otherwise the revision after the submitted one). Clears
	 * dirty only when the draft still equals what was submitted; an edit made
	 * while the save was in flight keeps the editor dirty.
	 */
	acknowledge: (submission: EditorSubmission<S>, landedRevision?: number) => void;
	/** Unconditionally clean, catching the draft up to the latest server row. */
	markClean: () => void;
	/**
	 * Keep the draft but build it on the latest server row, so the next save
	 * names that row's revision (the "keep my version" answer to a conflict).
	 */
	rebase: () => void;
	/** Throw the draft away and hydrate the latest server row. */
	reload: () => void;
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
	const held = () => opts.holdHydration?.() === true;

	const hydrate = (row: NonNullable<S>) => {
		hydrating = true;
		generation += 1;
		hydratedFrom = row;
		base = row;
		baseRevision = opts.revision?.(row);
		hydratedIdentity = identityOf(row);
		opts.initialize(row);
		opts.onHydrate?.(row);
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
			if (!hasChanges.value && !held()) {
				// Nothing unsaved: follow the server.
				hydrate(row);
				return;
			}
			// Unsaved draft (or work not committed to it yet): keep it. A row at the draft's revision (a send
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

	// A row older than the revision the draft is built on — an emission from
	// before our own write, which the echo of that write will replace.
	const predatesBase = (row: NonNullable<S>) =>
		opts.revision !== undefined && baseRevision !== undefined && opts.revision(row) < baseRevision;

	const catchUp = () => {
		// An emission skipped while the draft was dirty (e.g. a settings save
		// that re-keys the row) is applied now that nothing is unsaved. One that
		// predates the write just acknowledged is not: it would put the content
		// from before that write back on screen until the echo arrived. Nor is
		// anything while work is held outside the draft; the release catches up.
		if (
			!held() &&
			latest !== null &&
			latest !== hydratedFrom &&
			identityOf(latest) === hydratedIdentity &&
			!predatesBase(latest)
		) {
			hydrate(latest);
		} else {
			setDirty(false);
		}
	};

	const acknowledge = (submission: EditorSubmission<S>, landedRevision?: number) => {
		// Re-hydrated while the save was in flight (clean draft followed the
		// server, or the editor moved to another entity): that state wins.
		if (submission.generation !== generation) return;
		if (landedRevision !== undefined || submission.revision !== undefined) {
			// The draft now builds on our write. Prefer the revision the server
			// says it stored over assuming the next one.
			baseRevision = landedRevision ?? (submission.revision as number) + 1;
			if (latest !== null && opts.revision?.(latest) === baseRevision) base = latest;
		} else if (opts.revision === undefined && latest !== null) {
			base = latest;
		}
		if (serializeDraft() === submission.draft) catchUp();
	};

	const rebase = () => {
		if (latest === null) return;
		base = latest;
		baseRevision = opts.revision?.(latest);
	};

	// Work held outside the draft was let go. If none of it was committed (the
	// draft is still clean), follow the emissions it held back. Waiting a tick
	// lets a commit made on release reach the tracked refs first.
	if (opts.holdHydration) {
		watch(opts.holdHydration, (isHeld) => {
			if (isHeld) return;
			void nextTick(() => {
				if (!held() && !hasChanges.value && isInitialized.value) catchUp();
			});
		});
	}

	const reload = () => {
		if (latest !== null) hydrate(latest);
	};

	return {
		hasChanges,
		isInitialized,
		beginSubmit,
		acknowledge,
		markClean: catchUp,
		rebase,
		reload,
	};
}
