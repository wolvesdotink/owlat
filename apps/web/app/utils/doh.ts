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

/** DoH JSON record types we query (RFC 1035 §3.2.2). */
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_NS = 2;

/** DoH JSON response status: 0 = NOERROR, 3 = NXDOMAIN (RFC 1035 §4.1.1). */
export const DNS_STATUS_NXDOMAIN = 3;

export type DohAnswer = { type: number; data: string };
export type DohResponse = { Status?: number; Answer?: DohAnswer[] };

/** Cloudflare DoH `type` query values for the record types we support. */
type DohRecordType = 'TXT' | 'NS';

/**
 * Resolve `domain`'s records of `type` over DNS-over-HTTPS. Returns the parsed
 * DoH JSON body, or `null` on any failure (network error, non-2xx, bad JSON) —
 * never throws.
 */
export async function dohQuery(domain: string, type: DohRecordType): Promise<DohResponse | null> {
	try {
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
		const response = await fetch(url, { headers: { Accept: 'application/dns-json' } });
		if (!response.ok) return null;
		return (await response.json()) as DohResponse;
	} catch {
		return null;
	}
}
