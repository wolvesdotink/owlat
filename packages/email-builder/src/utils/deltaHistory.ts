import { compare, applyPatch, type Operation } from 'fast-json-patch';
import type { HistoryState } from '../composables/useHistory';

export interface HistoryCheckpoint {
	type: 'checkpoint';
	state: HistoryState;
}

export interface HistoryDelta {
	type: 'delta';
	patches: Operation[];
	reversePatches: Operation[];
}

export type HistoryEntry = HistoryCheckpoint | HistoryDelta;

/**
 * Generate forward and reverse patches between two states
 */
export function generatePatches(
	oldState: HistoryState,
	newState: HistoryState
): { patches: Operation[]; reversePatches: Operation[] } {
	const patches = compare(oldState, newState);
	const reversePatches = compare(newState, oldState);
	return { patches, reversePatches };
}

/**
 * Apply patches to a state and return the new state
 */
export function applyPatches(state: HistoryState, patches: Operation[]): HistoryState {
	const cloned = JSON.parse(JSON.stringify(state));
	applyPatch(cloned, patches);
	return cloned;
}

/**
 * Determine if a checkpoint should be created based on the number of deltas since the last checkpoint
 */
export function shouldCreateCheckpoint(
	entries: HistoryEntry[],
	currentIndex: number,
	interval: number
): boolean {
	if (entries.length === 0) return true;

	let deltaCount = 0;
	for (let i = currentIndex; i >= 0; i--) {
		if (entries[i]?.type === 'checkpoint') break;
		deltaCount++;
	}

	return deltaCount >= interval;
}

/**
 * Reconstruct state at a given index by finding the nearest checkpoint and applying forward patches
 */
export function reconstructState(entries: HistoryEntry[], targetIndex: number): HistoryState {
	// Find nearest checkpoint at or before target
	let checkpointIndex = targetIndex;
	while (checkpointIndex >= 0 && entries[checkpointIndex]?.type !== 'checkpoint') {
		checkpointIndex--;
	}

	const checkpoint = entries[checkpointIndex] as HistoryCheckpoint;
	let state = JSON.parse(JSON.stringify(checkpoint.state)) as HistoryState;

	// Apply forward patches to reach target
	for (let i = checkpointIndex + 1; i <= targetIndex; i++) {
		const entry = entries[i];
		if (entry?.type === 'delta') {
			applyPatch(state, entry.patches);
		}
	}

	return state;
}
