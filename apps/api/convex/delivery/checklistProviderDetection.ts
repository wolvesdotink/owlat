'use node';

import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { trySplitZone } from '@owlat/shared/dnsZone';
import {
	detectDnsProvider,
	detectVpsProvider,
	type DnsProvider,
	type VpsProvider,
} from './checklistGuidance';

const MAX_RDAP_BYTES = 64 * 1_024;

export function dnsProviderObservation(provider: DnsProvider | null): string[] {
	return provider ? [`dns-provider=${provider}`] : [];
}

export async function detectDomainDnsProvider(domain: string): Promise<DnsProvider | null> {
	const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
	const zone = trySplitZone(domain);
	if (!zone) return null;
	const finalOffset = Math.min(labels.length - zone.registrable.split('.').length, 6);
	for (let offset = 0; offset <= finalOffset; offset += 1) {
		try {
			const provider = detectDnsProvider(await dns.resolveNs(labels.slice(offset).join('.')));
			if (provider) return provider;
		} catch {
			// A sending subdomain commonly has no delegation; walk toward its zone.
		}
	}
	return null;
}

function rdapOrganization(value: unknown): string | null {
	const values: string[] = [];
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 4 || values.length >= 64) return;
		if (typeof candidate === 'string') {
			if (candidate.length <= 512) values.push(candidate);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const entry of candidate.slice(0, 32)) visit(entry, depth + 1);
			return;
		}
		if (typeof candidate !== 'object' || candidate === null) return;
		const record = candidate as Record<string, unknown>;
		for (const key of ['name', 'handle', 'fn', 'org', 'entities', 'vcardArray']) {
			visit(record[key], depth + 1);
		}
	};
	visit(value, 0);
	return values.length > 0 ? values.join(' ') : null;
}

const RDAP_ENDPOINTS = [
	'https://rdap.arin.net/registry/ip/',
	'https://rdap.db.ripe.net/ip/',
	'https://rdap.apnic.net/ip/',
	'https://rdap.lacnic.net/rdap/ip/',
	'https://rdap.afrinic.net/rdap/ip/',
] as const;

async function fetchRdapOrganization(
	endpoint: string,
	ip: string,
	signal: AbortSignal
): Promise<string | null> {
	try {
		const response = await fetch(`${endpoint}${encodeURIComponent(ip)}`, {
			redirect: 'error',
			signal,
			headers: { Accept: 'application/rdap+json' },
		});
		const length = Number(response.headers.get('content-length'));
		if (!response.ok || (Number.isFinite(length) && length > MAX_RDAP_BYTES)) {
			return null;
		}
		const body = await readBoundedText(response);
		return body ? rdapOrganization(JSON.parse(body)) : null;
	} catch {
		return null;
	}
}

async function readBoundedText(response: Response): Promise<string | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let result = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_RDAP_BYTES) {
				await reader.cancel();
				return null;
			}
			result += decoder.decode(chunk.value, { stream: true });
		}
		return result + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

export async function detectIpProvider(ip: string | undefined): Promise<VpsProvider | null> {
	if (!ip || isIP(ip) === 0) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 4_000);
	try {
		for (const endpoint of RDAP_ENDPOINTS) {
			const organization = await fetchRdapOrganization(endpoint, ip, controller.signal);
			const provider = detectVpsProvider(organization);
			if (provider) return provider;
		}
		return null;
	} finally {
		clearTimeout(timeout);
	}
}
