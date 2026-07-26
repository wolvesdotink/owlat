import type { DeliverabilityChecklistStatus } from '@owlat/shared';
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
	return [
		`dns=${boundedDnsField(label, 24)}`,
		`name=${boundedDnsField(record ? absoluteDnsRecordName(record, domain) : 'missing', 64)}`,
		`type=${boundedDnsField(record?.type ?? 'TXT', 8)}`,
		`expected=${boundedDnsField(expectedValue, 72)}`,
		`observed=${boundedDnsField(result?.foundValue ?? 'missing', 72)}`,
		`verified=${result?.verified ?? false}`,
		`reason=${boundedDnsField(result?.error ?? 'none', 64)}`,
		`checked-at=${result?.lastChecked ?? 'missing'}`,
	].join('; ');
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
