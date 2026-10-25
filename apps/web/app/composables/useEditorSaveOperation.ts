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

/**
 * A save refused for any other reason, from a run that asked to stay quiet (a
 * background save): nothing has been shown yet, and `op` is what to show.
 */
export class SaveRefusedError extends SurfacedOperationError {
	constructor(readonly op: OperationError) {
		super(op.message || 'Saving failed');
	}
}

/** Per-call options of the save returned by {@link useEditorSaveOperation}. */
export interface EditorSaveRunOptions {
	/**
	 * A background save: a refusal is not toasted but thrown as a
	 * {@link SaveRefusedError} for the caller's own status to show, and the
	 * write is not announced to screen readers.
	 */
	quiet?: boolean;
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
): (args: FunctionArgs<M>, runOpts?: EditorSaveRunOptions) => Promise<FunctionReturnType<M>> {
	// Set by `onError` while `run` is settling; saves from one editor do not
	// overlap (the Save button, the shortcut and the autosave share one queue).
	let refusedAt: number | null = null;
	let refusal: OperationError | null = null;
	let quiet = false;
	const settle = (op: OperationError) => {
		refusedAt = staleDraftRevision(op);
		refusal = op;
		return refusedAt !== null || quiet;
	};
	const loud = useBackendOperation(operation, { label: opts.label, onError: settle });
	const silent = useBackendOperation(operation, {
		label: opts.label,
		onError: settle,
		announce: false,
	});

	return async (args, runOpts = {}) => {
		refusedAt = null;
		refusal = null;
		quiet = runOpts.quiet === true;
		const outcome = await (quiet ? silent : loud).run(args);
		if (outcome.ok) return outcome.result;
		if (refusedAt !== null) throw new StaleDraftError(refusedAt);
		// Written by `settle` while `run` was awaited.
		const refused = refusal as OperationError | null;
		if (quiet && refused) throw new SaveRefusedError(refused);
		throw new SurfacedOperationError('Saving the email failed');
	};
}
