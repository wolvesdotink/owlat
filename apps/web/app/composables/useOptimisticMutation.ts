import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import type {
	BackendOperationConfig,
	BackendOptimisticUpdate,
} from '~/composables/useBackendOperation';

/** Default lifetime of the "Undo" toast offered after a successful write. */
export const DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS = 8000;

export interface OptimisticUndo {
	/** Toast text, e.g. "Sender disabled". */
	label: string;
	/** The inverse action (usually another mutation). Run at most once, on click. */
	inverse: () => void | Promise<void>;
	/** How long the Undo toast stays offered. Defaults to 8s. */
	windowMs?: number;
}

export interface OptimisticApply<M extends FunctionReference<'mutation' | 'action'>> {
	/**
	 * Apply the optimistic change to component state *now* and return a closure
	 * that reverts it. The revert runs only if the authoritative write fails.
	 * For state that lives outside the Convex query cache (a hidden-row set, a
	 * local toggle); cached query results take `optimisticUpdate` instead.
	 */
	apply?: () => () => void;
	/**
	 * A Convex optimistic update for this run: patches the local query store
	 * while the write is in flight and is rolled back by the client itself, on
	 * success and failure alike. Overrides the operation's own
	 * `optimisticUpdate` for this run.
	 */
	optimisticUpdate?: BackendOptimisticUpdate<M>;
	/** Optional "Undo" toast offered once the write succeeds. */
	undo?: OptimisticUndo;
}

/**
 * Optimistic wrapper around {@link useBackendOperation} — the generalized form
 * of the Postbox-only optimism (`usePostboxOptimisticHide` +
 * `usePostboxTriageUndo`). Two kinds of optimism, usable together:
 *
 *  - Convex's native optimistic updates (`optimisticUpdate`, on the options or
 *    per run): the ConvexClient patches its cached query results the moment
 *    the mutation is sent and drops the patch once the server's result lands,
 *    so every subscription over those queries repaints at once and a failure
 *    needs no revert. Prefer this for anything a query returns.
 *  - `apply`: for component state outside the query cache. It runs on click,
 *    the live subscription confirms it, and a failed write runs its revert.
 *
 * Either way the shared, categorized error toast (owned by
 * `useBackendOperation`) explains a failure.
 *
 * Optimism is CLIENT-ONLY sugar: the server mutation stays the sole authority —
 * its permission checks, validation and telemetry are untouched. This helper
 * only reorders when the UI *reflects* a change the server will confirm; it
 * never substitutes for that confirmation. When a caller needs the mutation's
 * return value before proceeding, keep the plain round-trip `useBackendOperation`.
 */
export function useOptimisticMutation<M extends FunctionReference<'mutation' | 'action'>>(
	operation: M,
	opts: BackendOperationConfig<M>
): {
	run: (
		args: FunctionArgs<M>,
		optimistic: OptimisticApply<M>
	) => Promise<FunctionReturnType<M> | undefined>;
	isLoading: Readonly<Ref<boolean>>;
	inlineError: Readonly<Ref<string | null>>;
} {
	const { t } = useI18n();
	const backend = useBackendOperation(operation, opts);
	const { showToast } = useToast();

	function offerUndo(undo: OptimisticUndo): void {
		let done = false;
		showToast(undo.label, 'success', {
			durationMs: undo.windowMs ?? DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS,
			action: {
				label: t('shared.useOptimisticMutation.undo'),
				onAction: () => {
					if (done) return;
					done = true;
					void undo.inverse();
				},
			},
		});
	}

	const run = async (
		args: FunctionArgs<M>,
		optimistic: OptimisticApply<M>
	): Promise<FunctionReturnType<M> | undefined> => {
		const revert = optimistic.apply?.();
		const result = await backend.run(
			args,
			optimistic.optimisticUpdate ? { optimisticUpdate: optimistic.optimisticUpdate } : undefined
		);
		if (!result.ok) {
			// The write failed; `useBackendOperation` already surfaced the
			// categorized error. Roll the local change back (the client has
			// already dropped any `optimisticUpdate` patch by itself).
			revert?.();
			return undefined;
		}
		if (optimistic.undo) offerUndo(optimistic.undo);
		return result.result;
	};

	return {
		run,
		isLoading: backend.isLoading,
		inlineError: backend.inlineError,
	};
}
