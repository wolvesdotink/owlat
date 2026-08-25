/**
 * Cross-log submission (plan §9.1).
 *
 * Attestations go to at least two logs, so one log's outage — or one log's
 * misbehavior — loses nothing: the evidence exists elsewhere, and a monitor
 * comparing the two heads is what makes censorship detectable rather than
 * merely deplorable. A single-log failure is therefore expected traffic, not an
 * error condition, and this module reports per-log outcomes instead of throwing
 * on the first rejection.
 *
 * The network is injected. `postJson` is the app's HTTP client (retries,
 * timeouts, proxy settings and TLS policy are its business); this package never
 * reaches for `fetch`, and it never logs — outcomes come back as data for the
 * caller's logger.
 */
import type { Attestation } from '@owlat/ostr-core';

/**
 * POST `body` as JSON to `url`, resolving with the parsed response and
 * REJECTING on any non-success status. A poster that resolves on a 4xx makes
 * this module report an acceptance that never happened.
 */
export type PostJson = (url: string, body: unknown) => Promise<unknown>;

/** Logs an attestation must reach for §9.1's redundancy to hold. */
export const MIN_CROSS_SUBMIT_LOGS = 2;

export type LogOutcome =
	| { logUrl: string; ok: true; response: unknown }
	| { logUrl: string; ok: false; error: string };

export interface AttestationSubmission {
	attestation: Attestation;
	/** One outcome per distinct log URL, in the order given. */
	outcomes: LogOutcome[];
	acceptedLogs: number;
	/** At least one log took it: the attestation is in the record. */
	accepted: boolean;
	/** At least {@link MIN_CROSS_SUBMIT_LOGS} took it: §9.1 redundancy holds. */
	crossSubmitted: boolean;
}

export interface SubmitAllResult {
	submissions: AttestationSubmission[];
	/** Every attestation reached at least one log. */
	allAccepted: boolean;
	/** Every attestation reached at least {@link MIN_CROSS_SUBMIT_LOGS} logs. */
	crossSubmitted: boolean;
	/** Logs that rejected or failed every attestation — a retry target, and
	 *  worth surfacing: a log that is permanently unreachable is a log this
	 *  observer is no longer redundant against. */
	failedLogs: string[];
}

export interface SubmitAllInput {
	attestations: readonly Attestation[];
	postJson: PostJson;
	/** Full submission endpoints, e.g. `https://log.example/v1/submit`.
	 *  Duplicates are collapsed: posting twice to one log is not redundancy. */
	logUrls: readonly string[];
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message !== '') return error.message;
	if (typeof error === 'string' && error !== '') return error;
	return 'submission failed';
}

/**
 * Submit every attestation to every log, tolerating partial failure.
 *
 * Logs are attempted in parallel per attestation and attestations in order, so
 * an earlier record is never sequenced after a later one at a log that
 * timestamps on arrival. Nothing is retried here — the caller owns the retry
 * policy, and `submissions` carries exactly what it needs to retry the subset
 * that failed.
 *
 * @throws RangeError when no log URL is usable: silently succeeding at
 * submitting to nowhere would leave an observer believing it had published.
 */
export async function submitAll(input: SubmitAllInput): Promise<SubmitAllResult> {
	const logUrls = [
		...new Set(input.logUrls.filter((url) => typeof url === 'string' && url !== '')),
	];
	if (logUrls.length === 0) throw new RangeError('submitAll needs at least one log URL');

	// A window where the k-thresholds held everything back produces no drafts.
	// Reporting every log as failed then — nothing was posted to any of them —
	// would have the app alerting that its logs are dead and retrying against
	// logs it never contacted. Nothing to submit is a success with no traffic.
	if (input.attestations.length === 0) {
		return { submissions: [], allAccepted: true, crossSubmitted: true, failedLogs: [] };
	}

	const submissions: AttestationSubmission[] = [];
	const failedEverywhere = new Set(logUrls);

	for (const attestation of input.attestations) {
		const settled = await Promise.allSettled(
			logUrls.map(async (url) => input.postJson(url, attestation))
		);
		const outcomes = settled.map((result, index): LogOutcome => {
			// `logUrls` and `settled` are the same length by construction.
			const logUrl = logUrls[index] as string;
			if (result.status === 'fulfilled') {
				failedEverywhere.delete(logUrl);
				return { logUrl, ok: true, response: result.value };
			}
			return { logUrl, ok: false, error: describeError(result.reason) };
		});
		const acceptedLogs = outcomes.filter((outcome) => outcome.ok).length;
		submissions.push({
			attestation,
			outcomes,
			acceptedLogs,
			accepted: acceptedLogs > 0,
			crossSubmitted: acceptedLogs >= MIN_CROSS_SUBMIT_LOGS,
		});
	}

	return {
		submissions,
		allAccepted: submissions.every((submission) => submission.accepted),
		crossSubmitted:
			logUrls.length >= MIN_CROSS_SUBMIT_LOGS &&
			submissions.every((submission) => submission.crossSubmitted),
		failedLogs: logUrls.filter((url) => failedEverywhere.has(url)),
	};
}
