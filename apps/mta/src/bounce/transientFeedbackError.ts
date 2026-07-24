/**
 * A feedback-intake failure for which the remote MTA must retry the same bytes.
 *
 * Ordinary malformed or unattributed feedback is deliberately ACKed. This
 * error is reserved for transient storage failures after authenticated
 * feedback has entered a durable-processing path.
 */
export class TransientFeedbackProcessingError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = 'TransientFeedbackProcessingError';
	}
}
