import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import type { BackendOperationOptions } from '~/composables/useBackendOperation';

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

export interface OptimisticApply {
	/**
	 * Apply the optimistic change to local state *now* and return a closure that
	 * reverts it. The revert runs only if the authoritative write fails.
	 */
	apply: () => () => void;
	/** Optional "Undo" toast offered once the write succeeds. */
	undo?: OptimisticUndo;
}

/**
 * Optimistic wrapper around {@link useBackendOperation} — the generalized form
 * of the Postbox-only optimism (`usePostboxOptimisticHide` +
 * `usePostboxTriageUndo`). The ConvexClient has no native optimistic updates,
 * so a high-frequency mutation applies its change locally on click, and the
 * live subscription confirms it; a failed write restores the prior state and
 * the shared, categorized error toast (owned by `useBackendOperation`) explains
 * what happened.
 *
 * Optimism is CLIENT-ONLY sugar: the server mutation stays the sole authority —
 * its permission checks, validation and telemetry are untouched. This helper
 * only reorders when the UI *reflects* a change the server will confirm; it
 * never substitutes for that confirmation. When a caller needs the mutation's
 * return value before proceeding, keep the plain round-trip `useBackendOperation`.
 */
export function useOptimisticMutation<M extends FunctionReference<'mutation' | 'action'>>(
	operation: M,
	opts: BackendOperationOptions
): {
	run: (
		args: FunctionArgs<M>,
		optimistic: OptimisticApply
	) => Promise<FunctionReturnType<M> | undefined>;
	isLoading: Readonly<Ref<boolean>>;
	inlineError: Readonly<Ref<string | null>>;
} {
	const backend = useBackendOperation(operation, opts);
	const { showToast } = useToast();

	function offerUndo(undo: OptimisticUndo): void {
		let done = false;
		showToast(undo.label, 'success', {
			durationMs: undo.windowMs ?? DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS,
			action: {
				label: 'Undo',
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
		optimistic: OptimisticApply
	): Promise<FunctionReturnType<M> | undefined> => {
		const revert = optimistic.apply();
		const result = await backend.run(args);
		if (result === undefined) {
			// The write failed; `useBackendOperation` already surfaced the
			// categorized error. Roll the optimistic change back.
			revert();
			return undefined;
		}
		if (optimistic.undo) offerUndo(optimistic.undo);
		return result;
	};

	return {
		run,
		isLoading: backend.isLoading,
		inlineError: backend.inlineError,
	};
}
