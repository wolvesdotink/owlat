/**
 * The sending domain's DNS records as ONE checklist (Settings → Domains).
 *
 * The expanded domain row used to stack every record as an equally tall card
 * and summarise them as per-CATEGORY chips, so "DKIM ✗" never said which of
 * three selectors was the missing one and the operator had to scroll every card
 * hunting for a small red label. This module flattens the records into
 * per-RECORD entries — each with a stable id the summary can jump to, a status
 * and the group it belongs in — and derives the summary and the "copy the
 * missing records" payload from that same list, so the count, the jump links
 * and the rows can never disagree.
 *
 * Pure: no network, no i18n. Labels are the protocol acronyms (SPF, DKIM 2,
 * MAIL FROM MX), which read the same in every language.
 */
import {
	normalizeDnsRecord,
	type DnsRecordPanelRecord,
	type DomainDnsRecords,
} from './domainStatus';

/** One record's stored verification outcome. */
export type ChecklistVerification = {
	verified: boolean;
	error?: string;
	foundValue?: string;
};

type VerificationResults =
	| {
			spf?: ChecklistVerification;
			dkim?: ChecklistVerification[];
			dmarc?: ChecklistVerification;
			mailFrom?: ChecklistVerification[];
	  }
	| null
	| undefined;

/**
 * `verified` — found with the expected value. `failed` — the check ran and the
 * record is absent or different. `unchecked` — no check has run yet (a freshly
 * added domain), so nothing is known either way.
 */
export type ChecklistStatus = 'verified' | 'failed' | 'unchecked';

/** Authentication proves who may send; return-path carries the bounces. */
export type ChecklistGroup = 'authentication' | 'returnPath';

export type ChecklistEntry = {
	/** Stable within one domain — used for the jump-link anchor and copy keys. */
	id: string;
	label: string;
	group: ChecklistGroup;
	record: DnsRecordPanelRecord;
	verification: ChecklistVerification | undefined;
	status: ChecklistStatus;
};

const statusOf = (verification: ChecklistVerification | undefined): ChecklistStatus =>
	verification === undefined ? 'unchecked' : verification.verified ? 'verified' : 'failed';

const entry = (
	id: string,
	label: string,
	group: ChecklistGroup,
	record: DnsRecordPanelRecord | null,
	verification: ChecklistVerification | undefined
): ChecklistEntry[] =>
	record ? [{ id, label, group, record, verification, status: statusOf(verification) }] : [];

/**
 * Every record the domain asks the operator to publish, in display order. The
 * DKIM and MAIL FROM indexes line up with `verificationResults` because the
 * verifier walks the same arrays in the same order.
 */
export function buildSendingChecklist(domain: {
	dnsRecords?: DomainDnsRecords | null;
	verificationResults?: VerificationResults;
}): ChecklistEntry[] {
	const records = domain.dnsRecords;
	const results = domain.verificationResults ?? undefined;
	if (!records) return [];

	const dkim = records.dkim ?? [];
	const mailFrom = records.mailFrom ?? [];
	return [
		...entry('spf', 'SPF', 'authentication', normalizeDnsRecord(records.spf, 'TXT'), results?.spf),
		...dkim.flatMap((record, i) =>
			entry(
				`dkim-${i}`,
				// A single selector needs no number; several do, or "DKIM ✗" is
				// exactly the ambiguity this list exists to remove.
				dkim.length > 1 ? `DKIM ${i + 1}` : 'DKIM',
				'authentication',
				normalizeDnsRecord(record, 'CNAME'),
				results?.dkim?.[i]
			)
		),
		...entry(
			'dmarc',
			'DMARC',
			'authentication',
			normalizeDnsRecord(records.dmarc, 'TXT'),
			results?.dmarc
		),
		...mailFrom.flatMap((record, i) =>
			entry(
				`mail-from-${i}`,
				record.type === 'MX' ? 'MAIL FROM MX' : 'MAIL FROM SPF',
				'returnPath',
				normalizeDnsRecord(record, record.type === 'MX' ? 'MX' : 'TXT'),
				results?.mailFrom?.[i]
			)
		),
	];
}

export type ChecklistSummary = {
	total: number;
	verified: number;
	/** Records still to publish or fix, in display order. */
	outstanding: ChecklistEntry[];
	/** False until the first DNS check has produced any result. */
	checked: boolean;
	allVerified: boolean;
};

export function summarizeChecklist(entries: readonly ChecklistEntry[]): ChecklistSummary {
	const verified = entries.filter((e) => e.status === 'verified').length;
	return {
		total: entries.length,
		verified,
		outstanding: entries.filter((e) => e.status !== 'verified'),
		checked: entries.some((e) => e.status !== 'unchecked'),
		allVerified: entries.length > 0 && verified === entries.length,
	};
}

/** The record's absolute name, per the same host rule the verifier uses. */
export function recordFqdn(record: { host: string; hostIsFqdn?: boolean }, domain: string) {
	if (record.host === '@') return domain;
	return record.hostIsFqdn ? record.host : `${record.host}.${domain}`;
}

const absolute = (name: string) => (name.endsWith('.') ? name : `${name}.`);

/**
 * A TXT value as zone-file character-strings: quoted, `"` and `\` escaped, and
 * split every 255 octets (RFC 1035 §3.3.14 caps one string at 255). A 2048-bit
 * DKIM key is ~400 characters, so this is the common case, not an edge.
 */
function txtRdata(value: string): string {
	const escaped = (chunk: string) => chunk.replace(/[\\"]/g, (c) => `\\${c}`);
	const chunks: string[] = [];
	for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
	return (chunks.length > 0 ? chunks : ['']).map((c) => `"${escaped(c)}"`).join(' ');
}

function rdata(record: DnsRecordPanelRecord, valueOverride?: string): string {
	const value = valueOverride ?? record.value;
	switch (record.type) {
		case 'TXT':
			return txtRdata(value);
		case 'CNAME':
			return absolute(value);
		case 'MX':
			return `${record.priority ?? 10} ${absolute(value)}`;
		default:
			return value;
	}
}

/** Default TTL for the exported lines — the value most DNS hosts pre-fill. */
const ZONE_TTL = 3600;

/**
 * Standard zone-file lines (RFC 1035 master-file format) for the given records.
 * Absolute names, so the text is unambiguous whichever zone it is pasted into
 * or whoever it is forwarded to — many DNS hosts import it directly.
 *
 * `valueOverrides` swaps a record's value by entry id: the SPF row publishes the
 * merged record instead when the domain already has a foreign `v=spf1`.
 */
export function toZoneFileLines(
	entries: readonly ChecklistEntry[],
	domain: string,
	valueOverrides: Partial<Record<string, string>> = {}
): string {
	return entries
		.map((e) =>
			[
				absolute(recordFqdn(e.record, domain)),
				ZONE_TTL,
				'IN',
				e.record.type,
				rdata(e.record, valueOverrides[e.id]),
			].join('\t')
		)
		.join('\n');
}
