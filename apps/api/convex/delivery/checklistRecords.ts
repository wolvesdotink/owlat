import type { DeliverabilityCheckId } from '@owlat/shared';
import { reverseIpAddressForDns } from '@owlat/shared/ipAddress';
import { buildMtaStsTxtValue, mtaStsPolicyId } from '@owlat/shared/mtaStsPolicy';
import type { Doc } from '../_generated/dataModel';

type RecordValue = {
	type?: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host?: string;
	hostname?: string;
	value: string;
	priority?: number;
};

export type CopyableRecord = {
	id: string;
	label: string;
	name: string;
	type: string;
	value: string;
	ttl: number;
};

function absoluteRecordName(record: RecordValue, domain: string): string {
	if (record.hostname) return record.hostname;
	if (!record.host || record.host === '@') return domain;
	return `${record.host}.${domain}`;
}

function copyableRecord(
	itemId: DeliverabilityCheckId,
	domain: string,
	record: RecordValue,
	index: number
): CopyableRecord {
	const type = record.type ?? 'TXT';
	return {
		id: `${itemId}:${index}`,
		label: `${type} record`,
		name: absoluteRecordName(record, domain),
		type,
		value: record.priority === undefined ? record.value : `${record.priority} ${record.value}`,
		ttl: 3_600,
	};
}

export function domainRecordsForItem(
	itemId: DeliverabilityCheckId,
	domain: Doc<'domains'>,
	trackingDomains: readonly Doc<'trackingDomains'>[],
	settings: Doc<'instanceSettings'> | null,
	warming: Doc<'warmingState'> | null
): CopyableRecord[] {
	let records: RecordValue[] = [];
	switch (itemId) {
		case 'domain.spf':
			records = domain.dnsRecords.spf ? [domain.dnsRecords.spf] : [];
			break;
		case 'domain.dkim':
			records = domain.dnsRecords.dkim ?? [];
			break;
		case 'domain.dmarc':
			records = domain.dnsRecords.dmarc ? [domain.dnsRecords.dmarc] : [];
			break;
		case 'domain.return_path':
			records = domain.dnsRecords.mailFrom ?? [];
			break;
		case 'domain.mta_sts': {
			const mode = settings?.mtaStsMode ?? 'none';
			const mailHost = warming?.ips.find((entry) => entry.fcrdns?.ehlo)?.fcrdns?.ehlo;
			if (mode !== 'none' && mailHost) {
				records = [
					{
						type: 'TXT',
						hostname: `_mta-sts.${domain.domain}`,
						value: buildMtaStsTxtValue(mtaStsPolicyId(mode, [mailHost])),
					},
				];
			}
			break;
		}
		case 'domain.tls_rpt':
			records =
				domain.dnsRecords.tlsRpt?.type !== 'TLSA' && domain.dnsRecords.tlsRpt
					? [domain.dnsRecords.tlsRpt]
					: [];
			break;
		case 'domain.tlsa':
			records = domain.dnsRecords.tlsa
				? [domain.dnsRecords.tlsa]
				: domain.dnsRecords.tlsRpt?.type === 'TLSA'
					? [domain.dnsRecords.tlsRpt]
					: [];
			break;
		case 'domain.tracking': {
			const tracking = trackingDomains.find(
				(row) => row.domain === domain.domain || row.domain.endsWith(`.${domain.domain}`)
			);
			if (tracking) {
				records = [
					{
						type: 'CNAME',
						hostname: tracking.domain,
						value: tracking.cnameTarget,
					},
				];
			}
			break;
		}
		default:
			break;
	}
	return records.map((record, index) => copyableRecord(itemId, domain.domain, record, index));
}

function ptrRecordName(ip: string): string | null {
	const reversed = reverseIpAddressForDns(ip);
	if (!reversed) return null;
	return `${reversed}.${ip.includes(':') ? 'ip6.arpa' : 'in-addr.arpa'}`;
}

/** Exact deployment-side values derived from the live MTA identity snapshot. */
export function deploymentRecordsForItem(
	itemId: DeliverabilityCheckId,
	warming: Doc<'warmingState'> | null
): CopyableRecord[] {
	if (!warming) return [];
	const ipv6Item = itemId.startsWith('deployment.ipv6_');
	const ips = warming.ips.filter((entry) => entry.ip.includes(':') === ipv6Item);
	return ips.flatMap((entry, index): CopyableRecord[] => {
		const ehlo = entry.fcrdns?.ehlo;
		const id = `${itemId}:${index}`;
		switch (itemId) {
			case 'deployment.ptr':
			case 'deployment.ipv6_ptr': {
				const name = ptrRecordName(entry.ip);
				return name && ehlo
					? [
							{
								id,
								label: 'PTR record',
								name,
								type: 'PTR',
								value: ehlo,
								ttl: 3_600,
							},
						]
					: [];
			}
			case 'deployment.fcrdns':
			case 'deployment.ipv6_aaaa':
				return ehlo
					? [
							{
								id,
								label: ipv6Item ? 'AAAA record' : 'A record',
								name: ehlo,
								type: ipv6Item ? 'AAAA' : 'A',
								value: entry.ip,
								ttl: 3_600,
							},
						]
					: [];
			case 'deployment.ehlo_ptr':
				return ehlo
					? [
							{
								id,
								label: 'SMTP EHLO hostname',
								name: 'EHLO',
								type: 'SMTP',
								value: ehlo,
								ttl: 0,
							},
						]
					: [];
			case 'deployment.ipv6_spf':
				return entry.ipv6Spf?.domain
					? [
							{
								id,
								label: 'IPv6 SPF record',
								name: entry.ipv6Spf.domain,
								type: 'TXT',
								value: `v=spf1 ip6:${entry.ip} -all`,
								ttl: 3_600,
							},
						]
					: [];
			default:
				return [];
		}
	});
}
