import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import type { OperationError } from '@owlat/shared/operationError';
import { SurfacedOperationError } from '~/lib/operationError';

/**
 * The editor save's write, as the Email editor bridge wants it: resolve with
 * the mutation's result, or reject.
 *
 * `useBackendOperation` never throws; it toasts and resolves `{ ok: false }`.
 * The bridge needs a rejection to keep the draft dirty, and it needs to tell a
 * stale-revision refusal (the email changed after the draft loaded) apart from
 * every other failure: that one is not an error to read and dismiss but a
 * choice to make, so it is claimed from the toast policy and handed to the
 * bridge's conflict dialog as a {@link StaleDraftError}.
 */

/** A save refused because the email moved past the revision the draft was built on. */
export class StaleDraftError extends SurfacedOperationError {
	constructor(readonly currentRevision: number) {
		super('The email changed after the draft was loaded');
	}
}

/** The server's revision when `op` is a stale-revision refusal, else null. */
export function staleDraftRevision(op: OperationError): number | null {
	if (op.category !== 'conflict' || op.data?.['reason'] !== 'stale_content_revision') return null;
	const current = op.data['currentRevision'];
	return typeof current === 'number' ? current : null;
}

export function useEditorSaveOperation<M extends FunctionReference<'mutation'>>(
	operation: M,
	opts: { label: () => string }
): (args: FunctionArgs<M>) => Promise<FunctionReturnType<M>> {
	// Set by `onError` while `run` is settling; saves from one editor do not
	// overlap (the Save button and the shortcut both wait for `isSaving`).
	let refusedAt: number | null = null;
	const { run } = useBackendOperation(operation, {
		label: opts.label,
		onError: (op) => {
			refusedAt = staleDraftRevision(op);
			return refusedAt !== null;
		},
	});

	return async (args) => {
		refusedAt = null;
		const outcome = await run(args);
		if (outcome.ok) return outcome.result;
		if (refusedAt !== null) throw new StaleDraftError(refusedAt);
		throw new SurfacedOperationError('Saving the email failed');
	};
}
