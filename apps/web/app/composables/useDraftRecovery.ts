import { computed, type ComputedRef, type ShallowRef } from 'vue';
import type { DraftCandidate, DraftEvent, DraftSessionState } from '~/utils/draftSession';
import type { EditorDraftStore } from '~/utils/editorDraftStore';
import type { EditorDraftWriters } from '~/utils/editorDraftWriters';

/**
 * Draft recovery: the device copies other editors of this draft left behind
 * (written offline, or by an editor that closed before its save landed), and
 * the notice that offers one. Reading and binding only: what happens to a copy
 * is the session's decision (`utils/draftSession.ts`). A copy is never put
 * into the editor without the person choosing Restore, whatever server state
 * it names, and a copy whose editor may still be open is never deleted.
 */

export interface DraftRecoveryOffer<T> {
	/** When the copy was written. */
	savedAt: number;
	data: T;
}

export interface DraftRecovery<T> {
	/** A copy waiting for the person's choice. */
	pending: ComputedRef<DraftRecoveryOffer<T> | null>;
	/** Edited since it was offered: the next Restore replaces that work. */
	confirm: ComputedRef<boolean>;
	restore: () => void;
	discard: () => void;
}

export interface DraftCopyReader<T> {
	store: EditorDraftStore;
	writers: EditorDraftWriters;
	/** This editor's writer id: its own copy is not a candidate. */
	own: string;
	accept: (data: unknown) => data is T;
	/** Whether a copy says what the editor shows now. */
	matches: (data: T) => boolean;
}

/**
 * The copies under `scope` other editors wrote, newest first, with whether
 * their editor is still open. `remember` keeps each copy's data for Restore.
 */
export async function readDraftCandidates<T>(
	reader: DraftCopyReader<T>,
	scope: string,
	remember: (token: string, data: T) => void
): Promise<DraftCandidate[]> {
	const [found, liveness] = await Promise.all([
		reader.store.list(scope, reader.accept),
		reader.writers.liveness(),
	]);
	return found
		.filter((copy) => copy.writerId !== reader.own)
		.map((copy) => {
			remember(copy.token, copy.data);
			return {
				key: copy.key,
				token: copy.token,
				liveness: liveness(copy.writerId),
				savedAt: copy.savedAt,
				base: copy.base,
				matches: reader.matches(copy.data),
			};
		});
}

/** The offer as the recovery notice binds it. */
export function useDraftRecovery<T>(
	state: Readonly<ShallowRef<DraftSessionState>>,
	dispatch: (event: DraftEvent) => void,
	dataOf: (token: string) => T | undefined,
	beforeChoice: () => void
): DraftRecovery<T> {
	return {
		pending: computed(() => {
			const offer = state.value.offer;
			const data = offer ? dataOf(offer.candidate.token) : undefined;
			return offer && data !== undefined ? { savedAt: offer.candidate.savedAt, data } : null;
		}),
		confirm: computed(() => state.value.offer?.confirm === true),
		restore: () => {
			beforeChoice();
			dispatch({ type: 'recovery-restore' });
		},
		discard: () => dispatch({ type: 'recovery-discard' }),
	};
}
