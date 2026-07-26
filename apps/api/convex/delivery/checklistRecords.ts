import type { DeliverabilityCheckId } from "@owlat/shared";
import { reverseIpAddressForDns } from "@owlat/shared/ipAddress";
import { buildMtaStsTxtValue, mtaStsPolicyId } from "@owlat/shared/mtaStsPolicy";
import type { Doc } from "../_generated/dataModel";
import { getOptional } from "../lib/env";

export type ChecklistDnsRecord = {
	type?: "TXT" | "CNAME" | "MX" | "TLSA";
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

export function absoluteDnsRecordName(record: ChecklistDnsRecord, domain: string): string {
	const name =
		record.hostname ?? (!record.host || record.host === "@" ? domain : `${record.host}.${domain}`);
	return name.toLowerCase().replace(/\.$/, "");
}

/**
 * The readiness checklist requires a terminal hard-fail policy. Domain
 * registration may retain a staged soft-fail value while addresses settle, so
 * the checklist must show the exact hardened replacement it will verify.
 */
export function hardenedSpfRecordValue(value: string): string {
	const trimmed = value.trim();
	return /(?:^|\s)[+?~]?all$/i.test(trimmed) ? trimmed.replace(/[+?~]?all$/i, "-all") : trimmed;
}

function copyableRecord(
	itemId: DeliverabilityCheckId,
	domain: string,
	record: ChecklistDnsRecord,
	index: number,
): CopyableRecord {
	const type = record.type ?? "TXT";
	return {
		id: `${itemId}:${index}`,
		label: `${type} record`,
		name: absoluteDnsRecordName(record, domain),
		type,
		value: record.priority === undefined ? record.value : `${record.priority} ${record.value}`,
		ttl: 3_600,
	};
}

export function domainRecordsForItem(
	itemId: DeliverabilityCheckId,
	domain: Doc<"domains">,
	trackingDomains: readonly Doc<"trackingDomains">[],
	settings: Doc<"instanceSettings"> | null,
): CopyableRecord[] {
	let records: ChecklistDnsRecord[] = [];
	switch (itemId) {
		case "domain.spf":
			records = domain.dnsRecords.spf
				? [
						{
							...domain.dnsRecords.spf,
							value: hardenedSpfRecordValue(domain.dnsRecords.spf.value),
						},
					]
				: [];
			break;
		case "domain.dkim":
			records = domain.dnsRecords.dkim ?? [];
			break;
		case "domain.dmarc":
			records = domain.dnsRecords.dmarc ? [domain.dnsRecords.dmarc] : [];
			break;
		case "domain.return_path":
			records = domain.dnsRecords.mailFrom ?? [];
			break;
		case "domain.mta_sts": {
			const mode = settings?.mtaStsMode ?? "none";
			const mailHost = getOptional("EHLO_HOSTNAME")?.trim();
			if (mode !== "none" && mailHost) {
				records = [
					{
						type: "TXT",
						hostname: `_mta-sts.${domain.domain}`,
						value: buildMtaStsTxtValue(mtaStsPolicyId(mode, [mailHost])),
					},
				];
			}
			break;
		}
		case "domain.tls_rpt":
			records =
				domain.dnsRecords.tlsRpt?.type !== "TLSA" && domain.dnsRecords.tlsRpt
					? [domain.dnsRecords.tlsRpt]
					: [];
			break;
		case "domain.tlsa":
			records = domain.dnsRecords.tlsa
				? [domain.dnsRecords.tlsa]
				: domain.dnsRecords.tlsRpt?.type === "TLSA"
					? [domain.dnsRecords.tlsRpt]
					: [];
			break;
		case "domain.tracking": {
			const tracking = trackingDomains.find(
				(row) => row.domain === domain.domain || row.domain.endsWith(`.${domain.domain}`),
			);
			if (tracking) {
				records = [
					{
						type: "CNAME",
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
	return `${reversed}.${ip.includes(":") ? "ip6.arpa" : "in-addr.arpa"}`;
}

/** Exact deployment-side values derived from the live MTA identity snapshot. */
export function deploymentRecordsForItem(
	itemId: DeliverabilityCheckId,
	warming: Doc<"warmingState"> | null,
): CopyableRecord[] {
	if (!warming) return [];
	const ipv6Item = itemId.startsWith("deployment.ipv6_");
	const ips = warming.ips.filter((entry) => entry.ip.includes(":") === ipv6Item);
	if (itemId === "deployment.ipv6_spf") {
		const addressesByDomain = new Map<string, Set<string>>();
		for (const entry of ips) {
			const domain = entry.ipv6Spf?.domain;
			if (!domain) continue;
			const addresses = addressesByDomain.get(domain) ?? new Set<string>();
			addresses.add(entry.ip);
			addressesByDomain.set(domain, addresses);
		}
		return [...addressesByDomain.entries()].map(([domain, addresses], index) => ({
			id: `${itemId}:${index}`,
			label: "SPF mechanisms to add",
			name: domain,
			type: "TXT fragment",
			value: [...addresses]
				.sort()
				.map((address) => `ip6:${address}`)
				.join(" "),
			ttl: 3_600,
		}));
	}
	return ips.flatMap((entry, index): CopyableRecord[] => {
		const ehlo = entry.fcrdns?.ehlo;
		const id = `${itemId}:${index}`;
		switch (itemId) {
			case "deployment.ptr":
			case "deployment.ipv6_ptr": {
				const name = ptrRecordName(entry.ip);
				return name && ehlo
					? [
							{
								id,
								label: "PTR record",
								name,
								type: "PTR",
								value: ehlo,
								ttl: 3_600,
							},
						]
					: [];
			}
			case "deployment.fcrdns":
			case "deployment.ipv6_aaaa":
				return ehlo
					? [
							{
								id,
								label: ipv6Item ? "AAAA record" : "A record",
								name: ehlo,
								type: ipv6Item ? "AAAA" : "A",
								value: entry.ip,
								ttl: 3_600,
							},
						]
					: [];
			case "deployment.ehlo_ptr":
				return ehlo
					? [
							{
								id,
								label: "SMTP EHLO hostname",
								name: "EHLO",
								type: "SMTP",
								value: ehlo,
								ttl: 0,
							},
						]
					: [];
			default:
				return [];
		}
	});
}
