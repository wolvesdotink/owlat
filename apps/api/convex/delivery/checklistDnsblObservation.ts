import {
	checklistObservation,
	inconclusiveObservation,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

type OutboundAddress = NonNullable<ChecklistVerificationContext['warming']>['ips'][number];

/**
 * The deployment blocklist check. Only a listing fails it: a snapshot too old
 * to judge, or an address whose standing is unknown, is inconclusive, because
 * public resolvers often refuse blocklist queries and an alert on each refusal
 * would fire for a server that is not listed anywhere.
 */
export function observeDnsbl(
	addresses: readonly OutboundAddress[],
	isSnapshotFresh: boolean
): ChecklistObservation {
	const observedValues = addresses.flatMap((entry) => [
		`${entry.ip}=${entry.dnsbl ?? 'unknown'}`,
		`${entry.ip}:checked-at=${entry.dnsblCheckedAt ?? 'missing'}`,
	]);
	if (!isSnapshotFresh) {
		return inconclusiveObservation(
			'mta.dnsbl',
			'The MTA blocklist snapshot is missing or too old to verify this check.',
			observedValues
		);
	}
	// A listing is asked first: one address's unknown standing must not
	// soften another address that is known to be listed.
	if (addresses.some((entry) => entry.dnsbl === 'critical' || entry.dnsbl === 'degraded')) {
		return checklistObservation(
			'mta.dnsbl',
			'fail',
			'At least one outbound address is listed on a monitored DNS blocklist.',
			observedValues
		);
	}
	if (addresses.every((entry) => entry.dnsbl === 'clean')) {
		return checklistObservation(
			'mta.dnsbl',
			'pass',
			'Every outbound address is clean on the monitored DNS blocklists.',
			observedValues
		);
	}
	return inconclusiveObservation(
		'mta.dnsbl',
		'At least one outbound address has unknown standing on the monitored DNS blocklists.',
		observedValues
	);
}
