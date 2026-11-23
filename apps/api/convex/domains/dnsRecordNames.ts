/**
 * The name each sending-domain record is looked up at. The verifier
 * (`dnsVerification.ts`) resolves these names and `GET /api/v1/domains` tells a
 * caller to publish there, so both read them from here and cannot disagree.
 *
 * An SPF record on the apex is stored with the host `@`; DKIM and DMARC are
 * always relative to the domain. A MAIL FROM record with an absolute
 * `hostname` lives on a return-path domain that is a sibling of the domain,
 * not a host under it.
 */

type NamedRecord = { host?: string; hostname?: string };

export type SendingRecordKind = 'spf' | 'dkim' | 'dmarc' | 'mailFrom';

export function dnsRecordLookupName(
	kind: SendingRecordKind,
	record: NamedRecord,
	domain: string
): string {
	if (kind === 'spf' && record.host === '@') return domain;
	if (kind === 'mailFrom' && record.hostname) return record.hostname;
	return `${record.host}.${domain}`;
}
