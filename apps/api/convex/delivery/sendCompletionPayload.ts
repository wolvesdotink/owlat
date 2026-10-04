import { ConvexError, type Infer } from 'convex/values';
import { isTransactionLimitError } from '../lib/convexLimitErrors';
import type { workpoolRunResultValidator } from '../schema/sendCompletionFailures';
import type { WorkerEnvelopeInput } from './workerEnvelope';
import { isSendWorkerOutcome } from './workerOutcome';

// ============================================================================
// The stored form of a recorded completion's worker result (#1195).
//
// A PAYLOAD IS NEVER LARGE. What a replay needs from the worker result is small:
// the provider id and type of an acceptance, a suppression reason, a park's
// start and retry state, a failure's error text. The one large part, the
// envelope (recipient and rendered message, up to the workpool's own limits), is
// needed only to re-enter a deferral or an open acceptance, and the record never
// replays that branch: `recordCompletionFailure` re-enters such a Send itself,
// in the transaction that commits, through the same `./sendRetryPlan` decision
// the arm would have taken. What remains to replay is the terminal branch, which
// reads no envelope. So the envelope is replaced by an empty stub of its kind
// and the payload is flagged; a replay that would still re-enter (a clock moved
// backwards) refuses with `ENVELOPE_NOT_STORED` instead of mailing the stub.
//
// The envelope is also the only place the recipient and the message content
// were in this table, so stripping it keeps them out.
//
// A HARD CAP AT WRITE. The compact result is measured, and one over
// `PAYLOAD_MAX_BYTES` is not stored at all: the record goes straight to
// `exhausted` with `PAYLOAD_TOO_LARGE` for an operator. Every listing and
// deletion path sizes its batches on this cap (`./sendCompletionFailureAdmin`).
// ============================================================================

type RunResult = Infer<typeof workpoolRunResultValidator>;

/** The largest stored payload. Real compact results are well under 2 KiB. */
export const PAYLOAD_MAX_BYTES = 32 * 1024;
/** A workpool failure's error text, kept as the Send's error message on replay. */
const ERROR_TEXT_MAX_CHARS = 2000;

function emptyEnvelope(envelope: WorkerEnvelopeInput): WorkerEnvelopeInput {
	const template = { subject: '', htmlContent: '' };
	return envelope.kind === 'campaign'
		? { kind: 'campaign', to: '', from: '', template, contactInfo: { email: '' } }
		: {
				kind: 'transactional',
				emailPurpose: envelope.emailPurpose,
				to: '',
				from: '',
				template,
			};
}

export interface CompactResult {
	result: RunResult;
	isEnvelopeStripped: boolean;
}

/** The stored form of a run result: envelopes emptied, error text clamped. */
export function compactRunResult(result: RunResult): CompactResult {
	if (result.kind === 'failed') {
		return {
			result: { kind: 'failed', error: result.error.slice(0, ERROR_TEXT_MAX_CHARS) },
			isEnvelopeStripped: false,
		};
	}
	if (result.kind !== 'success') return { result, isEnvelopeStripped: false };
	const outcome: unknown = result.returnValue;
	// Replayed down the same named path (`WORKER_RESULT_MALFORMED`), which reads
	// nothing of the value.
	if (!isSendWorkerOutcome(outcome)) {
		return { result: { kind: 'success', returnValue: null }, isEnvelopeStripped: false };
	}
	if (outcome.kind === 'deferred' || outcome.kind === 'acceptanceUnknown') {
		return {
			result: {
				kind: 'success',
				returnValue: { ...outcome, envelopeInput: emptyEnvelope(outcome.envelopeInput) },
			},
			isEnvelopeStripped: true,
		};
	}
	return { result, isEnvelopeStripped: false };
}

/** UTF-8 bytes of the JSON form: a close estimate of the stored size. */
export function payloadBytes(result: RunResult): number {
	return new TextEncoder().encode(JSON.stringify(result)).length;
}

/**
 * The diagnostic code stored for an error, never its text. A Convex validation
 * error quotes the whole document it refused, and the first line alone can
 * carry a name or a subject. An operator who needs the message runs
 * `applyRecordedCompletion` by hand: the CLI shows the error and nothing is
 * written.
 */
export function completionErrorCode(error: unknown): string {
	if (error instanceof ConvexError) {
		const data: unknown = error.data;
		const code =
			typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['code'] : null;
		return typeof code === 'string' && /^[a-z_]{1,40}$/i.test(code)
			? `CONVEX_ERROR_${code.toUpperCase()}`
			: 'CONVEX_ERROR';
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/does not match the schema|validator|ValidationError/i.test(message)) {
		return 'CONVEX_VALIDATION';
	}
	if (isTransactionLimitError(message)) return 'TRANSACTION_LIMIT';
	if (message.includes('conflicts with the Send provider identity')) {
		return 'MTA_IDENTITY_CONFLICT';
	}
	if (message.startsWith('Unhandled send worker outcome')) return 'UNHANDLED_WORKER_OUTCOME';
	if (message === 'ENVELOPE_NOT_STORED') return 'ENVELOPE_NOT_STORED';
	if (error instanceof TypeError) return 'TYPE_ERROR';
	if (error instanceof RangeError) return 'RANGE_ERROR';
	return 'UNKNOWN';
}
