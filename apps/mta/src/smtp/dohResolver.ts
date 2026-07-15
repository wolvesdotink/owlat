/**
 * Bounded DNS-over-HTTPS JSON client shared by DANE MX/address/TLSA discovery.
 *
 * The configured resolver is the DNSSEC validator. Every response retains its
 * AD bit so callers can distinguish secure, insecure, and failed lookups rather
 * than treating all syntactically valid DNS answers as equally trustworthy.
 */

import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';

const DOH_FETCH_TIMEOUT_MS = 10_000;
const DOH_MAX_RESPONSE_BYTES = 65_536;

export interface DohAnswer {
	name?: string;
	type?: number;
	TTL?: number;
	data?: string;
}

export interface DohResponse {
	Status?: number;
	AD?: boolean;
	Answer?: DohAnswer[];
}

export type DohQueryResult = { ok: true; response: DohResponse } | { ok: false; reason: string };

/** Query one RR type through the validating resolver under a hard byte cap. */
export async function queryDohJson(
	resolverUrl: string,
	name: string,
	recordType: number
): Promise<DohQueryResult> {
	const url = new URL(resolverUrl);
	url.searchParams.set('name', name);
	url.searchParams.set('type', String(recordType));
	url.searchParams.set('do', '1');

	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(DOH_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return { ok: false, reason: `DoH HTTP ${response.status}` };

		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > DOH_MAX_RESPONSE_BYTES) {
			return { ok: false, reason: `DoH response too large (${declared} bytes)` };
		}

		let bytes: Uint8Array | null;
		try {
			bytes = await readStreamBytes(response.body, DOH_MAX_RESPONSE_BYTES);
		} catch (error) {
			if (error instanceof StreamByteLimitExceeded) {
				return { ok: false, reason: `DoH response exceeds ${DOH_MAX_RESPONSE_BYTES} bytes` };
			}
			throw error;
		}
		if (!bytes) return { ok: false, reason: 'DoH response has no body' };

		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return { ok: false, reason: 'DoH response is not an object' };
		}
		return { ok: true, response: parsed as DohResponse };
	} catch {
		return { ok: false, reason: 'DoH request failed' };
	}
}
