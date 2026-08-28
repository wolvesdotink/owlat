/**
 * How deep does mail search actually reach on this instance? (idea 32)
 *
 * The server indexes either the 200-character `snippet` or the ~8KB
 * `searchBody` excerpt, and it only reads the deeper index once the instance
 * opted in AND the mailbox's excerpt backfill has completed. Search that
 * silently stops at character 200 is the exact failure idea 32 exists to
 * remove, so the UI has to be able to SAY which of those states it is in —
 * which means resolving it from the same two facts the server does, in one pure
 * place, rather than re-deriving "is it deep?" per component.
 *
 * The four states are deliberately distinct because their remedies differ: an
 * operator turns the switch on, an owner runs the backfill, and "indexing" just
 * needs waiting out.
 */

/** The backfill job row, narrowed to what the depth decision reads. */
export interface BodySearchBackfillJob {
	mode: 'index' | 'purge';
	status: 'running' | 'completed' | 'cancelled' | 'failed';
}

export type PostboxBodySearchDepth =
	/** The body index is live: whole-message text is searchable. */
	| 'deep'
	/** The instance never opted in — searching stops at the snippet by policy. */
	| 'disabled'
	/** Opted in, walk in flight — existing mail is still snippet-only for now. */
	| 'indexing'
	/** Opted in, but this mailbox's existing mail has never been walked. */
	| 'pending';

export function resolveBodySearchDepth(input: {
	isIndexingEnabled: boolean;
	job: BodySearchBackfillJob | null | undefined;
}): PostboxBodySearchDepth {
	if (!input.isIndexingEnabled) return 'disabled';
	const job = input.job;
	if (job?.status === 'running' && job.mode === 'index') return 'indexing';
	// A completed PURGE is not a completed index — it is the opt-out's sweep,
	// and treating it as readiness would promise depth over erased excerpts.
	if (job?.status === 'completed' && job.mode === 'index') return 'deep';
	return 'pending';
}

/**
 * The hint to show under the search box, or `null` when search is as deep as it
 * can be and there is nothing to explain. A `{key}` registry rather than a
 * string: the copy is resolved at the render boundary by `useI18n`, so this
 * module stays testable without a Vue/i18n mount.
 */
const HINT_KEYS: Record<PostboxBodySearchDepth, string | null> = {
	deep: null,
	disabled: 'dashboard.postbox.search.depth.disabled',
	indexing: 'dashboard.postbox.search.depth.indexing',
	pending: 'dashboard.postbox.search.depth.pending',
};

export function bodySearchDepthHint(depth: PostboxBodySearchDepth): { key: string } | null {
	const key = HINT_KEYS[depth];
	return key === null ? null : { key };
}
