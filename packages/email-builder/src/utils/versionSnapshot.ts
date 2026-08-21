import type { EditorBlock } from '../types';
import type { HistoryState } from '../composables/useHistory';

/**
 * Persisted version snapshots — the serialization seam between the editor's
 * in-memory working state and a stored snapshot row.
 *
 * `useHistory` keeps the session's undo stack as `HistoryState`
 * (`{ blocks, name, subject }`); a persisted snapshot is the same triple with
 * `blocks` serialized to the `EditorBlock[]` JSON string the backend already
 * stores as the template's content. Restoring therefore only has to parse back
 * into a `HistoryState` and assign it to the editor's refs, at which point the
 * ordinary change watcher records it as one more undoable edit — a restore is
 * never a special, un-undoable jump.
 */
export interface VersionSnapshotPayload {
	/** `EditorBlock[]` JSON, as stored on the template row. */
	content: string;
	name: string;
	subject: string;
}

/** Serialize the editor's working state into a storable snapshot payload. */
export function serializeHistoryState(state: HistoryState): VersionSnapshotPayload {
	return {
		content: JSON.stringify(state.blocks),
		name: state.name,
		subject: state.subject,
	};
}

/**
 * Parse a stored snapshot back into editor state.
 *
 * Tolerant by construction: a snapshot whose `content` predates a block-shape
 * change (or was truncated) must still restore its name and subject rather than
 * throwing inside the editor — the user can then fix the body by hand instead
 * of losing the whole restore.
 */
export function deserializeVersionSnapshot(snapshot: VersionSnapshotPayload): HistoryState {
	return {
		blocks: parseSnapshotBlocks(snapshot.content),
		name: snapshot.name,
		subject: snapshot.subject,
	};
}

/** `EditorBlock[]` from a snapshot's JSON, or `[]` for anything unusable. */
export function parseSnapshotBlocks(content: string): EditorBlock[] {
	try {
		const parsed: unknown = JSON.parse(content || '[]');
		if (!Array.isArray(parsed)) return [];
		// Drop anything that is not block-shaped: a partially corrupt snapshot
		// restores the blocks it still has instead of poisoning the canvas.
		return parsed.filter(
			(block): block is EditorBlock =>
				typeof block === 'object' &&
				block !== null &&
				typeof (block as EditorBlock).id === 'string' &&
				typeof (block as EditorBlock).type === 'string'
		);
	} catch {
		return [];
	}
}

/** Whether a snapshot differs from the current working state. */
export function snapshotMatchesState(
	snapshot: VersionSnapshotPayload,
	state: HistoryState
): boolean {
	const serialized = serializeHistoryState(state);
	return (
		serialized.content === snapshot.content &&
		serialized.name === snapshot.name &&
		serialized.subject === snapshot.subject
	);
}

/** Human-readable snapshot size for the history panel. */
export function formatSnapshotSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
