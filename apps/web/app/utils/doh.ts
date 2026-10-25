/**
 * Low-level DNS-over-HTTPS query shared by the client-side DNS hints (SPF
 * coexistence, sending-domain pre-checks). Convex/browser can't use the Node
 * `dns` module, so we resolve records over Cloudflare's DoH JSON endpoint.
 *
 * Fail-soft by design: any network / parse error — or a non-2xx response —
 * resolves to `null`. A DoH hiccup must never throw into the UI or leave an
 * unhandled rejection; callers treat `null` as "couldn't determine".
 *
 * The request host is fixed; only the record name is caller-supplied and it is
 * always sent URL-encoded as a query param.
 */

import { isRecord } from '@owlat/shared/utils/guards';
import { decodeJsonValue, guardDecoder } from '@owlat/worker-protocol/decodeJson';

/** DoH JSON record types we query (RFC 1035 §3.2.2). */
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_NS = 2;

/** DoH JSON response status: 0 = NOERROR, 3 = NXDOMAIN (RFC 1035 §4.1.1). */
export const DNS_STATUS_NXDOMAIN = 3;

export type DohAnswer = { type: number; data: string };
export type DohResponse = { Status?: number; Answer?: DohAnswer[] };

function isDohAnswer(value: unknown): value is DohAnswer {
	return isRecord(value) && typeof value['type'] === 'number' && typeof value['data'] === 'string';
}

/**
 * A DoH JSON body: `Status` a number and `Answer` a list of records when
 * present. A body of any other shape is not an answer the hints can trust.
 */
const dohResponseDecoder = guardDecoder(
	(value): value is DohResponse =>
		isRecord(value) &&
		(value['Status'] === undefined || typeof value['Status'] === 'number') &&
		(value['Answer'] === undefined ||
			(Array.isArray(value['Answer']) && value['Answer'].every(isDohAnswer))),
	'$: expected a DoH JSON response'
);

/** Cloudflare DoH `type` query values for the record types we support. */
type DohRecordType = 'TXT' | 'NS';

/**
 * Resolve `domain`'s records of `type` over DNS-over-HTTPS. Returns the parsed
 * DoH JSON body, or `null` on any failure (network error, non-2xx, bad JSON, a
 * body that is not a DoH response) — never throws.
 */
export async function dohQuery(domain: string, type: DohRecordType): Promise<DohResponse | null> {
	try {
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
		const response = await fetch(url, { headers: { Accept: 'application/dns-json' } });
		if (!response.ok) return null;
		const decoded = decodeJsonValue(await response.json(), dohResponseDecoder);
		return decoded.ok ? decoded.value : null;
	} catch {
		return null;
	}
}
