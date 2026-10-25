import { ref, watch, type Ref } from 'vue';
import { untilReached } from '~/lib/untilReached';
import type { EmailEditorCoedit } from './useEmailEditorCoedit';

/**
 * What answering a stale-revision conflict needs, shared by the email
 * editor's manual draft (`useEmailEditorBridge.ts`) and a draft's autosave
 * session (`useEmailEditorAutosave.ts`).
 */

/** How long a conflict choice waits for the live query to deliver the newer row. */
const CONFLICT_CATCH_UP_MS = 5000;

export interface EmailEditorConflictChoice<S> {
	isResolving: Ref<boolean>;
	/**
	 * Run one conflict answer. The server row a conflict names can reach this
	 * tab a moment after the refusal, and answering against an older emission
	 * would hide the change the person was just told about: it waits
	 * (briefly) for `revision` first. One answer at a time.
	 */
	resolve: (revision: number, choose: () => Promise<void> | void) => Promise<void>;
	/**
	 * Live: whether the shared session, built on an older row, may be saved
	 * over the latest one ("keep my version").
	 */
	canKeepLive: () => boolean;
	latest: () => NonNullable<S> | null;
}

export function useEmailEditorConflictChoice<S>(host: {
	source: Ref<S>;
	revision?: (row: NonNullable<S>) => number;
	canKeepDraft?: (base: NonNullable<S>, latest: NonNullable<S>) => boolean;
	coediting: EmailEditorCoedit | null;
}): EmailEditorConflictChoice<S> {
	const latest = () => (host.source.value as NonNullable<S> | null) ?? null;
	const revisionOf = (row: NonNullable<S> | null) =>
		row && host.revision ? host.revision(row) : null;

	// The row the session was last based on.
	let rowAtSessionBase: NonNullable<S> | null = null;
	if (host.coediting) {
		const coediting = host.coediting;
		watch([latest, () => coediting.meta.value], ([row, meta]) => {
			if (row && meta && revisionOf(row) === meta.baseRevision) rowAtSessionBase = row;
		});
	}

	const isResolving = ref(false);
	const resolve = async (revision: number, choose: () => Promise<void> | void) => {
		if (isResolving.value) return;
		isResolving.value = true;
		try {
			await untilReached(
				host.source,
				() => (revisionOf(latest()) ?? revision) >= revision,
				CONFLICT_CATCH_UP_MS
			);
			await choose();
		} finally {
			isResolving.value = false;
		}
	};

	const canKeepLive = () => {
		const row = latest();
		return !rowAtSessionBase || !row || host.canKeepDraft?.(rowAtSessionBase, row) !== false;
	};

	return { isResolving, resolve, canKeepLive, latest };
}
