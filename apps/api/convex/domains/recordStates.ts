/**
 * Each sending domain with the DNS records it needs and what the last check
 * found at each, in the public contract's shape. `GET /api/v1/domains` returns
 * it and the assistant's delivery-health tool reads it.
 *
 * Every field here is one a member already reads on the Domains page
 * (`domains.listByOrganization` is member-readable): the records are values
 * published in public DNS, and so is what a check found. The provider
 * identities beside the row (SES tokens, the MTA's selector table), the stored
 * resolver and registration errors, and the return-path sync error stay out.
 */

import type {
	DnsRecordState,
	SendingDomainRecord,
	SendingDomainSetup,
} from '@owlat/public-contract';
import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import type { DnsRecord, DnsRecords, VerificationResult, VerificationResults } from './domains';
import { dnsRecordLookupName, type SendingRecordKind } from './dnsRecordNames';

/**
 * A check that reached the record: `wrong` when it found a value at the name,
 * `missing` when it found none. A lookup DNS did not answer proves nothing
 * either way, the same rule the verdict follows (`lifecycleVerdict.ts`).
 */
function stateOf(result: VerificationResult | undefined): DnsRecordState {
	if (!result || result.inconclusive === true) return 'unchecked';
	if (result.verified) return 'found';
	return result.foundValue === undefined ? 'missing' : 'wrong';
}

/** The type the verifier checks the record as (`runDnsLookups`). */
function typeOf(kind: SendingRecordKind, record: DnsRecord): SendingDomainRecord['type'] {
	if (kind === 'dkim' && record.type === 'CNAME') return 'CNAME';
	if (kind === 'mailFrom' && record.type === 'MX') return 'MX';
	return 'TXT';
}

const PURPOSE: Record<SendingRecordKind, SendingDomainRecord['purpose']> = {
	spf: 'spf',
	dkim: 'dkim',
	dmarc: 'dmarc',
	mailFrom: 'mail_from',
};

function recordOf(
	kind: SendingRecordKind,
	record: DnsRecord,
	result: VerificationResult | undefined,
	domain: string
): SendingDomainRecord {
	const type = typeOf(kind, record);
	const state = stateOf(result);
	return {
		purpose: PURPOSE[kind],
		type,
		host: dnsRecordLookupName(kind, record, domain),
		value: record.value,
		priority: type === 'MX' ? (record.priority ?? null) : null,
		state,
		foundValue: state === 'wrong' ? (result?.foundValue ?? null) : null,
	};
}

/**
 * The records in the Domains page's order: SPF, each DKIM selector, DMARC,
 * then the return-path records. The DKIM and MAIL FROM results line up with
 * their records by index because the verifier walks the same arrays.
 */
export function sendingDomainSetup(row: Doc<'domains'>): SendingDomainSetup {
	const records = row.dnsRecords as DnsRecords;
	const results = (row.verificationResults ?? {}) as VerificationResults;
	return {
		id: row._id,
		domain: row.domain,
		status: row.status,
		lastCheckedAt:
			row.lastVerifiedAt === undefined ? null : new Date(row.lastVerifiedAt).toISOString(),
		records: [
			...(records.spf ? [recordOf('spf', records.spf, results.spf, row.domain)] : []),
			...(records.dkim ?? []).map((record, i) =>
				recordOf('dkim', record, results.dkim?.[i], row.domain)
			),
			...(records.dmarc ? [recordOf('dmarc', records.dmarc, results.dmarc, row.domain)] : []),
			...(records.mailFrom ?? []).map((record, i) =>
				recordOf('mailFrom', record, results.mailFrom?.[i], row.domain)
			),
		],
	};
}

export async function loadSendingDomainSetups(db: DatabaseReader): Promise<SendingDomainSetup[]> {
	const rows = await db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most
	return rows.map(sendingDomainSetup);
}
