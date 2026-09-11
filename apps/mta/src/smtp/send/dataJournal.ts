/**
 * DATA-phase durability fence.
 *
 * The queue hands the sender a hook to await after the recipient server accepts
 * DATA with 354 and immediately before the body and terminator are written —
 * the point where the attempt must already be durably journalled. A failure of
 * that hook is not an SMTP failure, so it must not be classified as one: it is
 * wrapped here and unwrapped by the attempt phase, which re-throws the original
 * error out of the MX loop so the queue retries from a durable pre-DATA state.
 */

/** Keeps a failed durability fence out of SMTP/MX retry classification. */
export class SmtpDataBodyJournalTransitionError extends Error {
	constructor(readonly transitionFailure: unknown) {
		super('SMTP DATA body journal transition failed');
		this.name = 'SmtpDataBodyJournalTransitionError';
	}
}

/**
 * Wrap a caller's pre-body durability hook so its failure arrives at the
 * attempt's catch as a {@link SmtpDataBodyJournalTransitionError} rather than
 * as an indistinguishable DATA-phase error.
 */
export function fencedDataBodyWrite(hook: () => Promise<void>): () => Promise<void> {
	return async () => {
		try {
			await hook();
		} catch (transitionFailure) {
			throw new SmtpDataBodyJournalTransitionError(transitionFailure);
		}
	};
}
