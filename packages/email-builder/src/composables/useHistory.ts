import { ref, watch, type Ref } from 'vue';
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

export interface HistoryState {
	blocks: EditorBlock[];
	name: string;
	subject: string;
}

export interface UseHistoryOptions {
	maxHistory?: number;
	debounceMs?: number;
	checkpointInterval?: number;
}

export interface UseHistoryReturn {
	canUndo: Ref<boolean>;
	canRedo: Ref<boolean>;
	undo: () => void;
	redo: () => void;
	clearHistory: () => void;
	historyLength: Ref<number>;
	currentIndex: Ref<number>;
}

/**
 * Composable for managing undo/redo history in the email builder.
 * Uses delta-based storage with periodic checkpoints for memory efficiency.
 * Tracks changes to blocks, name, and subject and allows navigating through history.
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
		stateCache.set(index, structuredClone(state));
	};

	const invalidateCache = () => {
		stateCache.clear();
	};

	// Debounce timer
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Deep clone helper (structuredClone is faster and handles more types than JSON roundtrip)
	const cloneState = (): HistoryState => ({
		blocks: structuredClone(blocks.value),
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

	// Debounced state push
	const debouncedPushState = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			pushState();
		}, debounceMs);
	};

	// Apply a history state
	const applyState = (state: HistoryState) => {
		isNavigating.value = true;
		blocks.value = structuredClone(state.blocks);
		name.value = state.name;
		subject.value = state.subject;
		previousState = state;
		// Use nextTick equivalent with setTimeout to ensure state is applied
		setTimeout(() => {
			isNavigating.value = false;
		}, 0);
	};

	// Computed states
	const canUndo = ref(false);
	const canRedo = ref(false);
	const historyLength = ref(0);

	// Update computed states
	const updateComputedStates = () => {
		canUndo.value = currentIndex.value > 0;
		canRedo.value = currentIndex.value < entries.value.length - 1;
		historyLength.value = entries.value.length;
	};

	// Undo action
	const undo = () => {
		if (!canUndo.value) return;

		const currentEntry = entries.value[currentIndex.value];
		currentIndex.value--;

		if (currentEntry?.type === 'delta' && previousState) {
			// Fast path: apply reverse patches
			const newState = structuredClone(previousState) as HistoryState;
			applyPatch(newState, currentEntry.reversePatches);
			applyState(newState);
			setCachedState(currentIndex.value, newState);
		} else {
			// Check cache first
			const cached = getCachedState(currentIndex.value);
			if (cached) {
				applyState(structuredClone(cached));
			} else {
				// Reconstruct and cache
				const state = reconstructState(entries.value, currentIndex.value);
				setCachedState(currentIndex.value, state);
				applyState(state);
			}
		}

		updateComputedStates();
	};

	// Redo action
	const redo = () => {
		if (!canRedo.value) return;

		currentIndex.value++;
		const entry = entries.value[currentIndex.value];

		if (entry?.type === 'delta' && previousState) {
			// Fast path: apply forward patches
			const newState = structuredClone(previousState) as HistoryState;
			applyPatch(newState, entry.patches);
			applyState(newState);
			setCachedState(currentIndex.value, newState);
		} else if (entry?.type === 'checkpoint') {
			// Use checkpoint state directly
			const state = structuredClone(entry.state);
			applyState(state);
			setCachedState(currentIndex.value, state);
		} else {
			// Check cache first
			const cached = getCachedState(currentIndex.value);
			if (cached) {
				applyState(structuredClone(cached));
			} else {
				// Reconstruct and cache
				const state = reconstructState(entries.value, currentIndex.value);
				setCachedState(currentIndex.value, state);
				applyState(state);
			}
		}

		updateComputedStates();
	};

	// Clear history
	const clearHistory = () => {
		const initialState = cloneState();
		const checkpoint: HistoryCheckpoint = {
			type: 'checkpoint',
			state: initialState,
		};
		entries.value = [checkpoint];
		currentIndex.value = 0;
		previousState = initialState;
		invalidateCache();
		updateComputedStates();
	};

	// Watch for changes and push to history
	watch(
		[blocks, name, subject],
		() => {
			if (!isNavigating.value) {
				debouncedPushState();
			}
			updateComputedStates();
		},
		{ deep: true }
	);

	// Initialize with current state
	pushState();
	updateComputedStates();

	return {
		canUndo,
		canRedo,
		undo,
		redo,
		clearHistory,
		historyLength,
		currentIndex,
	};
}
