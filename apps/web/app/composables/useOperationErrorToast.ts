import {
	isSurfacedOperationError,
	operationToastCopy,
	resolveOperationCopy,
} from '~/lib/operationError';

/**
 * The toast half of the Operation error seam (ADR-0036) for the throws a caller
 * catches ITSELF.
 *
 * `useBackendOperation` already owns the category → treatment policy for
 * anything it runs. This is for the gap either side of it: a helper that throws
 * before the mutation is reached (a draft row that could not be created), a
 * non-Convex step in the middle of one (decoding an attachment out of the MIME
 * tree), or a re-throw a caller uses for control flow. Those catch blocks used
 * to `console.error` and hand the user nothing at all.
 *
 * Same vocabulary, same copy rules, one line at the call site.
 */
export function useOperationErrorToast() {
	const { t } = useI18n();
	const { showToast } = useToast();

	/**
	 * Show `error` as an error toast, unless an Operation module has already
	 * shown it (see `SurfacedOperationError`).
	 *
	 * `fallbackKey` is the surface's own sentence, used only where the policy
	 * would otherwise fall back to the generic line.
	 *
	 * Returns whether a toast was raised, so a caller can tell "handled here"
	 * from "handled upstream" without re-inspecting the error.
	 */
	function showOperationError(error: unknown, fallbackKey?: string): boolean {
		if (isSurfacedOperationError(error)) return false;
		showToast(resolveOperationCopy(operationToastCopy(error, fallbackKey), t), 'error');
		return true;
	}

	return { showOperationError };
}
