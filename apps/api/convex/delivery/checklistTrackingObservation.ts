/**
 * The Center's `domain.tracking` item reports the verdict the tracking domain
 * check stored (`domains/trackingDomainVerdict.ts`: CNAME plus an HTTPS probe,
 * re-checked daily) and never re-derives it. A second, CNAME-only judgement
 * here would call a domain with a missing certificate verified while the
 * tracking domain surface, and the send path, refuse it.
 */

import type { Doc } from '../_generated/dataModel';
import type { TrackingDomainCheckOutcome } from '../lib/literalValidators';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

const FAILED_CHECK: Record<Exclude<TrackingDomainCheckOutcome, 'verified'>, string> = {
	dns_mismatch: 'The tracking CNAME does not point at this deployment.',
	https_unreachable:
		'The tracking domain does not answer over HTTPS with a valid certificate, so tracked links would break.',
	https_wrong_response:
		'The tracking domain answers over HTTPS, but not with this deployment’s tracking handler.',
	inconclusive: 'The last tracking domain check could not reach a verdict.',
};

function trackingRowFor(
	context: ChecklistVerificationContext,
	domain: string
): Doc<'trackingDomains'> | undefined {
	return context.tracking.find(
		(candidate) => candidate.domain === domain || candidate.domain.endsWith(`.${domain}`)
	);
}

export function observeTrackingDomain(
	context: ChecklistVerificationContext,
	providerValues: string[],
	isFinalDnsRetry: boolean
): ChecklistObservation {
	const row = trackingRowFor(context, context.domain!.domain);
	if (!row) {
		return checklistObservation(
			'tracking-domain.state',
			'warn',
			'No tracking domain is configured.',
			providerValues
		);
	}
	const observed = [
		...providerValues,
		`tracking-domain=${row.domain}`,
		`verified=${row.isVerified}`,
		...(row.lastCheck
			? [`last-check=${row.lastCheck.outcome}`, `last-check-at=${row.lastCheck.at}`]
			: []),
	];
	const lastFailure =
		row.lastCheck && row.lastCheck.outcome !== 'verified'
			? FAILED_CHECK[row.lastCheck.outcome]
			: null;
	if (row.isVerified) {
		return row.regressionSuspectedAt === undefined
			? checklistObservation(
					'tracking-domain.state',
					'pass',
					`${row.domain} is verified: its CNAME points here and it answers over HTTPS.`,
					observed
				)
			: checklistObservation(
					'tracking-domain.state',
					'warn',
					`${row.domain} failed its last check and is re-checked before it loses its verified state. ${lastFailure ?? ''}`.trim(),
					observed
				);
	}
	return checklistObservation(
		'tracking-domain.state',
		row.lastCheck?.outcome === 'inconclusive' ? 'warn' : pendingDnsStatus(isFinalDnsRetry),
		lastFailure ??
			`${row.domain} has not been verified yet. Verify it under the tracking domain settings.`,
		observed
	);
}
