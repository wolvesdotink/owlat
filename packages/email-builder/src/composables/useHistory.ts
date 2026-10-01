import {
	computed,
	getCurrentScope,
	onScopeDispose,
	ref,
	shallowRef,
	watch,
	type ComputedRef,
	type Ref,
	type WatchSource,
} from 'vue';
import { applyPatch } from 'fast-json-patch';
import type { EditorBlock } from '../types';
import {
	MAX_HISTORY_ENTRIES,
	HISTORY_DEBOUNCE_MS,
	HISTORY_CHECKPOINT_INTERVAL,
	MAX_HISTORY_CACHE_SIZE,
} from '../constants';
import {
	type HistoryEntry,
	type HistoryCheckpoint,
	type HistoryDelta,
	generatePatches,
	shouldCreateCheckpoint,
	reconstructState,
} from '../utils/deltaHistory';
import { plainClone } from '../utils/plainClone';

export interface HistoryState {
	blocks: EditorBlock[];
	name: string;
	subject: string;
}

export interface UseHistoryOptions {
	maxHistory?: number;
	debounceMs?: number;
	checkpointInterval?: number;
	/**
	 * A counter that goes up whenever `blocks` changes (useBlockTreeVersion).
	 * Given one, history watches it instead of deep-watching the block tree.
	 */
	blocksVersion?: WatchSource<number>;
}

export interface UseHistoryReturn {
	/** True when there is a committed step before the current one, or an edit waiting to be committed. */
	canUndo: ComputedRef<boolean>;
	/** True when there is a committed step after the current one and no pending edit that would discard it. */
	canRedo: ComputedRef<boolean>;
	undo: () => void;
	redo: () => void;
	clearHistory: () => void;
	/** Record an edit still waiting out the debounce now, instead of when the timer fires. */
	commitPending: () => void;
	/** Number of committed entries. */
	historyLength: ComputedRef<number>;
	currentIndex: Ref<number>;
}

/**
 * Composable for managing undo/redo history in the email builder.
 * Uses delta-based storage with periodic checkpoints for memory efficiency.
 * Tracks changes to blocks, name, and subject and allows navigating through history.
 *
 * An edit is committed once it has been quiet for `debounceMs`. Until then it is
 * pending: Undo is offered (it commits the edit first, then steps back over it),
 * Redo is not (committing the edit drops the redo branch). Undo, redo and
 * clearHistory settle the pending edit before they touch the entries, so a timer
 * armed before them can never land afterwards and rewrite the history they left.
 */
export function useHistory(
	blocks: Ref<EditorBlock[]>,
	name: Ref<string>,
	subject: Ref<string>,
	options: UseHistoryOptions = {}
): UseHistoryReturn {
	const {
		maxHistory = MAX_HISTORY_ENTRIES,
		debounceMs = HISTORY_DEBOUNCE_MS,
		checkpointInterval = HISTORY_CHECKPOINT_INTERVAL,
		blocksVersion,
	} = options;

	// History entries (checkpoints + deltas)
	const entries = ref<HistoryEntry[]>([]);
	const currentIndex = ref(-1);
	const isNavigating = ref(false);

	// Track previous state for generating diffs
	let previousState: HistoryState | null = null;

	// Cache for reconstructed states (index -> state) to avoid repeated reconstruction
	const stateCache = new Map<number, HistoryState>();
	const MAX_CACHE_SIZE = MAX_HISTORY_CACHE_SIZE;

	// The canvas blocks ref is deeply reactive, and `structuredClone` throws on
	// every proxy in it (even under `toRaw`, which unwraps only the top one).
	// plainClone reads through them with the JSON round trip's result.
	const deepClone = plainClone;

	const getCachedState = (index: number): HistoryState | undefined => {
		return stateCache.get(index);
	};

	const setCachedState = (index: number, state: HistoryState) => {
		// Evict oldest entry if at capacity
		if (stateCache.size >= MAX_CACHE_SIZE) {
			const firstKey = stateCache.keys().next().value;
			if (firstKey !== undefined) {
				stateCache.delete(firstKey);
			}
		}
		stateCache.set(index, deepClone(state));
	};

	const invalidateCache = () => {
		stateCache.clear();
	};

	// Debounce timer; `hasPending` mirrors it so the availability flags react.
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	const hasPending = shallowRef(false);
	// Clears `isNavigating` once the watcher has seen the state undo/redo applied.
	let navigatingTimer: ReturnType<typeof setTimeout> | null = null;

	const cloneState = (): HistoryState => ({
		blocks: deepClone(blocks.value),
		name: name.value,
		subject: subject.value,
	});

	// Push current state to history
	const pushState = () => {
		if (isNavigating.value) return;

		const newState = cloneState();

		// If we're not at the end of history, remove future entries
		if (currentIndex.value < entries.value.length - 1) {
			entries.value = entries.value.slice(0, currentIndex.value + 1);
			invalidateCache();
		}

		// Determine if we need a checkpoint or can use a delta
		const needsCheckpoint =
			entries.value.length === 0 ||
			shouldCreateCheckpoint(entries.value, currentIndex.value, checkpointInterval);

		if (needsCheckpoint || previousState === null) {
			// Create a full checkpoint
			const checkpoint: HistoryCheckpoint = {
				type: 'checkpoint',
				state: newState,
			};
			entries.value.push(checkpoint);
		} else {
			// Generate delta from previous state
			const { patches, reversePatches } = generatePatches(previousState, newState);

			// If patches are too large (50+ operations), create checkpoint instead
			if (patches.length >= 50) {
				const checkpoint: HistoryCheckpoint = {
					type: 'checkpoint',
					state: newState,
				};
				entries.value.push(checkpoint);
			} else {
				const delta: HistoryDelta = {
					type: 'delta',
					patches,
					reversePatches,
				};
				entries.value.push(delta);
			}
		}

		currentIndex.value = entries.value.length - 1;
		previousState = newState;

		// Trim history if it exceeds max
		if (entries.value.length > maxHistory) {
			// When trimming, ensure we don't leave orphaned deltas
			// Find the oldest checkpoint we can keep
			let trimIndex = 0;
			for (let i = 1; i < entries.value.length; i++) {
				if (entries.value[i]?.type === 'checkpoint') {
					trimIndex = i;
					break;
				}
			}
			// If no checkpoint found in first half, just trim one entry
			if (trimIndex === 0) trimIndex = 1;

			entries.value = entries.value.slice(trimIndex);
			currentIndex.value = entries.value.length - 1;
			invalidateCache();
		}
	};

	const cancelPending = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		hasPending.value = false;
	};

	// Debounced state push
	const debouncedPushState = () => {
		cancelPending();
		hasPending.value = true;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			hasPending.value = false;
			pushState();
		}, debounceMs);
	};

	const commitPending = () => {
		if (!debounceTimer) return;
		cancelPending();
		pushState();
	};

	// Apply a history state
	const applyState = (state: HistoryState) => {
		isNavigating.value = true;
		blocks.value = deepClone(state.blocks);
		name.value = state.name;
		subject.value = state.subject;
		previousState = state;
		// Use nextTick equivalent with setTimeout to ensure state is applied
		if (navigatingTimer) clearTimeout(navigatingTimer);
		navigatingTimer = setTimeout(() => {
			navigatingTimer = null;
			isNavigating.value = false;
		}, 0);
	};

	// Availability follows the committed entries, so every mutation of them
	// (push, branch truncation, trimming, clear) is reflected without a resync.
	const historyLength = computed(() => entries.value.length);
	const canUndo = computed(() => hasPending.value || currentIndex.value > 0);
	const canRedo = computed(
		() => !hasPending.value && currentIndex.value < entries.value.length - 1
	);

	// Undo action
	const undo = () => {
		// A pending edit is committed first, so this steps back over it.
		commitPending();
		if (currentIndex.value <= 0) return;

		const currentEntry = entries.value[currentIndex.value];
		currentIndex.value--;

		if (currentEntry?.type === 'delta' && previousState) {
			// Fast path: apply reverse patches
			const newState = deepClone(previousState) as HistoryState;
			applyPatch(newState, currentEntry.reversePatches);
			applyState(newState);
			setCachedState(currentIndex.value, newState);
		} else {
			// Check cache first
			const cached = getCachedState(currentIndex.value);
			if (cached) {
				applyState(deepClone(cached));
			} else {
				// Reconstruct and cache
				const state = reconstructState(entries.value, currentIndex.value);
				setCachedState(currentIndex.value, state);
				applyState(state);
			}
		}
	};

	// Redo action
	const redo = () => {
		// Committing a pending edit discards the redo branch, which leaves
		// nothing to redo; the bounds check below then makes this a no-op.
		commitPending();
		if (currentIndex.value >= entries.value.length - 1) return;

		currentIndex.value++;
		const entry = entries.value[currentIndex.value];

		if (entry?.type === 'delta' && previousState) {
			// Fast path: apply forward patches
			const newState = deepClone(previousState) as HistoryState;
			applyPatch(newState, entry.patches);
			applyState(newState);
			setCachedState(currentIndex.value, newState);
		} else if (entry?.type === 'checkpoint') {
			// Use checkpoint state directly
			const state = deepClone(entry.state);
			applyState(state);
			setCachedState(currentIndex.value, state);
		} else {
			// Check cache first
			const cached = getCachedState(currentIndex.value);
			if (cached) {
				applyState(deepClone(cached));
			} else {
				// Reconstruct and cache
				const state = reconstructState(entries.value, currentIndex.value);
				setCachedState(currentIndex.value, state);
				applyState(state);
			}
		}
	};

	// Clear history
	const clearHistory = () => {
		// The current state becomes the only entry, which already includes any
		// pending edit; its timer must not push on top of the reset later.
		cancelPending();
		const initialState = cloneState();
		const checkpoint: HistoryCheckpoint = {
			type: 'checkpoint',
			state: initialState,
		};
		entries.value = [checkpoint];
		currentIndex.value = 0;
		previousState = initialState;
		invalidateCache();
	};

	// Watch for changes and push to history
	const onChange = () => {
		if (!isNavigating.value) {
			debouncedPushState();
		}
	};
	if (blocksVersion) watch([blocksVersion, name, subject], onChange);
	else watch([blocks, name, subject], onChange, { deep: true });

	// The watchers stop with the owning scope; the timers have to as well, or a
	// push could still land after the editor unmounted.
	if (getCurrentScope()) {
		onScopeDispose(() => {
			cancelPending();
			if (navigatingTimer) {
				clearTimeout(navigatingTimer);
				navigatingTimer = null;
			}
		});
	}

	// Initialize with current state
	pushState();

	return {
		canUndo,
		canRedo,
		undo,
		redo,
		clearHistory,
		commitPending,
		historyLength,
		currentIndex,
	};
}
