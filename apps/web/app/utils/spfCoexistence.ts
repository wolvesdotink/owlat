/**
 * SPF coexistence hint (Settings → Domains + the desktop setup wizard).
 *
 * RFC 7208 §3.2 allows exactly ONE `v=spf1` record per host — a second one is a
 * PermError that breaks SPF for every sender at that host. So when a domain
 * already publishes an SPF record (e.g. it already sends through Google
 * Workspace), the SPF value we ask the operator to publish must be *merged*
 * into the existing record rather than added alongside it.
 *
 * This module resolves the domain's live TXT records over DNS-over-HTTPS
 * (Cloudflare — Convex/browser can't use the Node `dns` module) and, when a
 * foreign SPF record is found, computes the single merged record to suggest.
 * The merge itself is the shared, unit-tested `@owlat/shared/spf` helper so the
 * FE hint and the backend verifier fold mechanisms identically.
 *
 * Fail-soft by design: any network / parse error resolves to `null` (publish
 * ours as-is) — a DoH hiccup must never block the DNS panel.
 */
import { isSpfRecord, mergeSpfRecords, parseSpfMechanisms } from '@owlat/shared/spf';

/** DoH JSON answer record type for TXT (RFC 1035). */
const DNS_TYPE_TXT = 16;

type DohAnswer = { type: number; data: string };
type DohResponse = { Answer?: DohAnswer[] };

/**
 * Unwrap a DoH TXT `data` value. Cloudflare returns the TXT payload as one or
 * more double-quoted character-strings (RFC 1035 §3.3.14 splits records over
 * 255 bytes into several); concatenate their contents and drop the surrounding
 * quotes + backslash escapes. Falls back to the trimmed raw value when the
 * payload is not quoted.
 */
function unwrapTxtData(data: string): string {
	const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!chunks) return data.trim();
	return chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

/**
 * Resolve the TXT records published at `domain` over DNS-over-HTTPS. Returns the
 * (quote-unwrapped) TXT strings, or `[]` on any failure — callers treat an
 * empty result as "nothing to merge".
 */
export async function fetchSpfRecords(domain: string): Promise<string[]> {
	try {
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
		const response = await fetch(url, { headers: { Accept: 'application/dns-json' } });
		if (!response.ok) return [];
		const body = (await response.json()) as DohResponse;
		return (body.Answer ?? [])
			.filter((answer) => answer.type === DNS_TYPE_TXT)
			.map((answer) => unwrapTxtData(answer.data));
	} catch {
		return [];
	}
}

/**
 * Suggest a single merged SPF record when the domain already publishes a
 * foreign one that our value would collide with. Returns:
 *
 *  - `null` when no SPF record exists (safe to publish ours as-is), or when the
 *    existing record already carries every mechanism of ours (no change), or on
 *    any lookup/parse error (fail-soft).
 *  - `{ existing, merged }` otherwise — `merged` folds our mechanisms into the
 *    existing record, preserving its trailing qualifier/`all`.
 */
export async function computeSpfSuggestion(
	domain: string,
	ourSpfValue: string,
): Promise<{ existing: string; merged: string } | null> {
	try {
		const txtRecords = await fetchSpfRecords(domain);
		const existing = txtRecords.find((value) => isSpfRecord(value));
		if (!existing) return null;

		// Already merged: the existing record carries every mechanism of ours.
		const existingMechanisms = new Set(
			parseSpfMechanisms(existing).map((mechanism) => mechanism.toLowerCase()),
		);
		const alreadyPresent = parseSpfMechanisms(ourSpfValue).every((mechanism) =>
			existingMechanisms.has(mechanism.toLowerCase()),
		);
		if (alreadyPresent) return null;

		return { existing: existing.trim(), merged: mergeSpfRecords(existing, ourSpfValue) };
	} catch {
		return null;
	}
}
