import {
	serializeDeliverabilityObservation,
	type DeliverabilityChecklistStatus,
} from '@owlat/shared';
import { absoluteDnsRecordName, type ChecklistDnsRecord } from './checklistRecords';
import { pendingDnsStatus } from './checklistValidatorTypes';

export type DnsObservationResult = {
	verified: boolean;
	lastChecked?: number;
	error?: string;
	foundValue?: string;
};

export function isSuccessfulDnsResult(result: DnsObservationResult | undefined): boolean {
	return result?.verified === true && !result.error;
}

export function dnsResultStatus(
	result: DnsObservationResult | undefined,
	isFinalDnsRetry: boolean
): DeliverabilityChecklistStatus {
	return isSuccessfulDnsResult(result) ? 'pass' : pendingDnsStatus(isFinalDnsRetry);
}

export function dnsBundleStatus(
	results: readonly DnsObservationResult[] | undefined,
	isFinalDnsRetry: boolean,
	expectedCount: number
): DeliverabilityChecklistStatus {
	if (!results || results.length === 0 || results.length !== expectedCount) {
		return pendingDnsStatus(isFinalDnsRetry);
	}
	return results.every((result) => isSuccessfulDnsResult(result))
		? 'pass'
		: pendingDnsStatus(isFinalDnsRetry);
}

function boundedDnsField(value: string | number | boolean, maxLength: number): string {
	const text = String(value);
	if (text.length <= maxLength) return text;
	const marker = `…[length=${text.length}]`;
	return `${text.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

type DnsRecordObservation = {
	kind: 'dns_record';
	label: string;
	name: string;
	recordType: string;
	expected: string;
	observed: string;
	isVerified: boolean;
	reason: string;
	checkedAt: number | 'missing';
};

export function dnsRecordObservation(
	label: string,
	domain: string,
	record: ChecklistDnsRecord | undefined,
	result: DnsObservationResult | undefined
): string {
	const expectedValue = record
		? record.priority === undefined
			? record.value
			: `${record.priority} ${record.value}`
		: 'missing';
	return serializeDeliverabilityObservation({
		kind: 'dns_record',
		label: boundedDnsField(label, 24),
		name: boundedDnsField(record ? absoluteDnsRecordName(record, domain) : 'missing', 64),
		recordType: boundedDnsField(record?.type ?? 'TXT', 8),
		expected: boundedDnsField(expectedValue, 72),
		observed: boundedDnsField(result?.foundValue ?? 'missing', 72),
		isVerified: result?.verified ?? false,
		reason: boundedDnsField(result?.error ?? 'none', 64),
		checkedAt: result?.lastChecked ?? 'missing',
	} satisfies DnsRecordObservation);
}

export function dnsBundleObservations(
	label: string,
	domain: string,
	records: readonly ChecklistDnsRecord[],
	results: readonly DnsObservationResult[] | undefined
): string[] {
	const count = Math.max(1, records.length, results?.length ?? 0);
	return Array.from({ length: count }, (_, index) =>
		dnsRecordObservation(`${label}[${index}]`, domain, records[index], results?.[index])
	);
}

export function mtaStsObservation(input: {
	expectedId: string;
	observedId: string;
	isTxtRecordValid: boolean;
	isPolicyServedValid: boolean;
}): string {
	return serializeDeliverabilityObservation({
		kind: 'mta_sts',
		expectedId: boundedDnsField(input.expectedId, 160),
		observedId: boundedDnsField(input.observedId, 160),
		isTxtRecordValid: input.isTxtRecordValid,
		isPolicyServedValid: input.isPolicyServedValid,
	});
}
