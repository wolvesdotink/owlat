'use node';

/**
 * The submitting half of a window close (plan §9.1): posting signed
 * attestations to the logs and keeping the ledger of where each one landed.
 *
 * Partial failure is expected traffic here, not an error — a log that is down
 * is a log this instance re-posts to next hour. Everything in this module runs
 * AFTER the consumed state is durable, so a failed submission costs nothing but
 * the attempt.
 */

import { submitAll } from '@owlat/ostr-observer';
import type { Attestation } from '@owlat/ostr-core';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import type { ObserverConfig } from './config';
import { clampError, describeSubject, postJson } from './observerRuntime';

/** Re-post whatever no log has accepted yet, oldest first, before this window's
 *  own work — a log that timestamps on arrival must not receive a newer window
 *  ahead of an older one it already missed. */
export async function retryUnsettled(ctx: ActionCtx): Promise<void> {
	const unsettled = await ctx.runQuery(internal.ostr.observerState.listUnsettledSubmissions, {});
	for (const row of unsettled) {
		let attestation: unknown;
		try {
			attestation = JSON.parse(row.attestationJson);
		} catch {
			// A blob that will not parse can never be re-posted; settle it so the
			// retry set stays the set of things still worth trying.
			await ctx.runMutation(internal.ostr.observerState.settleSubmission, {
				id: row.id,
				acceptedLogUrls: row.acceptedLogUrls,
				pendingLogUrls: [],
				lastError: 'unreadable attestation blob',
			});
			continue;
		}
		const result = await submitAll({
			attestations: [attestation as Attestation],
			postJson,
			logUrls: row.pendingLogUrls,
		});
		const outcomes = result.submissions[0]?.outcomes ?? [];
		const accepted = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.logUrl);
		const failed = outcomes.filter((outcome) => !outcome.ok);
		const lastError = failed[0]?.ok === false ? clampError(failed[0].error) : undefined;
		const abandoned = await ctx.runMutation(internal.ostr.observerState.settleSubmission, {
			id: row.id,
			acceptedLogUrls: [...new Set([...row.acceptedLogUrls, ...accepted])],
			pendingLogUrls: failed.map((outcome) => outcome.logUrl),
			lastError,
		});
		if (abandoned) {
			// Operator-visible on purpose: a log this instance never reached is a
			// gap in what §9.1 claims it published, and the row is about to age out
			// with the rest.
			logError(
				'[OSTR] giving up on a submission after too many attempts:',
				failed.map((outcome) => outcome.logUrl).join(', '),
				'-',
				lastError ?? 'no error recorded'
			);
		}
	}
}

/**
 * Cross-submit already-signed attestations and record where each landed.
 *
 * Partial failure is expected traffic: the ledger keeps whatever no log has
 * accepted and the next window re-posts it.
 */
export async function submitSigned(
	ctx: ActionCtx,
	config: ObserverConfig & { domain: string; privateKeyBase64: string },
	attestations: readonly Attestation[]
): Promise<number> {
	if (attestations.length === 0) return 0;
	const result = await submitAll({ attestations, postJson, logUrls: config.logUrls });
	await ctx.runMutation(internal.ostr.observerState.recordSubmissions, {
		outcomes: result.submissions.map((submission) => {
			const failed = submission.outcomes.filter((outcome) => !outcome.ok);
			const firstFailure = failed[0];
			return {
				kind: submission.attestation.kind,
				subject: describeSubject(submission.attestation),
				windowFrom: submission.attestation.window?.from,
				windowTo: submission.attestation.window?.to,
				attestationJson: JSON.stringify(submission.attestation),
				acceptedLogUrls: submission.outcomes
					.filter((outcome) => outcome.ok)
					.map((outcome) => outcome.logUrl),
				pendingLogUrls: failed.map((outcome) => outcome.logUrl),
				lastError:
					firstFailure !== undefined && !firstFailure.ok
						? clampError(firstFailure.error)
						: undefined,
			};
		}),
	});
	if (!result.crossSubmitted) {
		logInfo('[OSTR] window published without cross-log redundancy:', result.failedLogs.join(', '));
	}
	return result.submissions.filter((submission) => submission.accepted).length;
}
