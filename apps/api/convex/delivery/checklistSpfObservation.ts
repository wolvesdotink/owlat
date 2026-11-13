import { spfTrailingAllQualifier } from '@owlat/shared/spf';
import type { Doc } from '../_generated/dataModel';
import type { runDnsLookups } from '../domains/dnsVerification';
import {
	dnsRecordObservation,
	dnsResultStatus,
	isSuccessfulDnsResult,
} from './checklistDnsObservations';
import {
	checklistSpfSource,
	hardenedSpfRecordValue,
	type ChecklistSpfSource,
} from './checklistRecords';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
} from './checklistValidatorTypes';

type DomainDnsResults = Awaited<ReturnType<typeof runDnsLookups>>;

function hasStrictSpfPolicy(value: string | undefined): boolean {
	return spfTrailingAllQualifier(value ?? '') === '-all';
}

/** The lookup result for the record {@link checklistSpfSource} picked. */
export function spfSourceResult(source: ChecklistSpfSource, results: DomainDnsResults) {
	return source.kind === 'apex' ? results.spf : results.mailFrom?.[source.mailFromIndex];
}

/** The `domain.spf` observation: the SPF record receivers evaluate, held to -all. */
export function observeSpfCheck(
	domain: Doc<'domains'>,
	results: DomainDnsResults,
	providerValues: string[],
	isFinalDnsRetry: boolean
): ChecklistObservation {
	const source = checklistSpfSource(domain);
	if (!source) {
		return checklistObservation(
			'dns.spf',
			'fail',
			'No SPF record is generated for this domain: there is no apex record and no SPF record on a return-path host. On the built-in MTA, set MTA_SPF_INCLUDE, or MTA_RETURN_PATH_DOMAIN together with MTA_IP_POOLS.',
			providerValues
		);
	}
	// The lookup used the stored record, the same input the Domains
	// verifier uses, so both read one verdict; the -all bar is this
	// checklist's own, judged on the value that is actually live.
	const result = spfSourceResult(source, results);
	const isLive = isSuccessfulDnsResult(result);
	const isStrict = hasStrictSpfPolicy(result?.foundValue ?? source.record.value);
	const subject =
		source.kind === 'apex'
			? 'SPF'
			: `SPF on the return-path host ${source.host}, which receivers check for this domain's mail,`;
	return checklistObservation(
		'dns.spf',
		isLive
			? isStrict
				? 'pass'
				: pendingDnsStatus(isFinalDnsRetry)
			: dnsResultStatus(result, isFinalDnsRetry),
		isLive && !isStrict
			? `${subject} is published, but it must end in -all for this checklist.`
			: (result?.error ??
					(isLive ? `${subject} is live and ends in -all.` : `${subject} is not live yet.`)),
		[
			...providerValues,
			dnsRecordObservation(
				'spf',
				domain.domain,
				{ ...source.record, value: hardenedSpfRecordValue(source.record.value) },
				result
			),
		]
	);
}
