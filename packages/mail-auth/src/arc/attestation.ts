/**
 * Sealed-AAR attestation (RFC 8601) — fail-closed.
 *
 * Reads the outermost sealer's sealed ARC-Authentication-Results and decides
 * whether it HONESTLY attests the ORIGINAL message passed for its visible From
 * domain. A `true` here is what lets a trusted forwarder suppress DMARC-fail
 * routing, so the predicate is fail-closed: an explicit `dmarc=fail` never
 * attests, and a bare SPF/DKIM pass counts only when it ALIGNS with the From.
 */

import { isSpfAligned } from '@owlat/shared/spfAlignment';
import type { HeaderField } from '../dkim/message.js';

/** The authentication methods parsed out of a sealed ARC-Authentication-Results. */
interface AarResults {
	readonly dmarc?: { readonly result: string; readonly from?: string };
	readonly spf?: { readonly result: string; readonly mailfrom?: string };
	readonly dkim: ReadonlyArray<{ readonly result: string; readonly d?: string }>;
}

/**
 * Parse a sealed ARC-Authentication-Results value (RFC 8601 grammar). Resinfo
 * entries are `;`-separated `method=result [ptype.prop=value ...]`; the leading
 * `i=` tag and the bare authserv-id carry no verdict and are skipped. Never throws.
 */
function parseAar(aar: HeaderField): AarResults {
	const colon = aar.raw.indexOf(':');
	const value = colon === -1 ? aar.raw : aar.raw.slice(colon + 1);

	let dmarc: AarResults['dmarc'];
	let spf: AarResults['spf'];
	const dkim: Array<{ result: string; d?: string }> = [];

	for (const segmentRaw of value.split(';')) {
		const segment = segmentRaw.replace(/[ \t\r\n]+/g, ' ').trim();
		if (segment === '') {
			continue;
		}
		const parts = segment.split(' ');
		const head = parts[0] ?? '';
		const eq = head.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const method = head.slice(0, eq).toLowerCase();
		const result = head.slice(eq + 1).toLowerCase();
		const props = new Map<string, string>();
		for (const prop of parts.slice(1)) {
			const pe = prop.indexOf('=');
			if (pe === -1) {
				continue;
			}
			props.set(prop.slice(0, pe).toLowerCase(), prop.slice(pe + 1));
		}
		if (method === 'dmarc') {
			const from = props.get('header.from');
			dmarc = { result, ...(from !== undefined ? { from } : {}) };
		} else if (method === 'spf') {
			const mailfrom = props.get('smtp.mailfrom');
			spf = { result, ...(mailfrom !== undefined ? { mailfrom } : {}) };
		} else if (method === 'dkim') {
			const d = props.get('header.d');
			dkim.push({ result, ...(d !== undefined ? { d } : {}) });
		}
	}

	return {
		...(dmarc !== undefined ? { dmarc } : {}),
		...(spf !== undefined ? { spf } : {}),
		dkim,
	};
}

/**
 * Did the sealed AAR honestly attest the ORIGINAL passed for its From domain?
 * Fail-closed: `dmarc=fail` never attests; `dmarc=pass` attests; with no DMARC
 * verdict, fall back ONLY to a passing SPF or DKIM that ALIGNS with the From.
 */
export function aarAttestsPass(aar: HeaderField): boolean {
	const ar = parseAar(aar);
	const dmarc = (ar.dmarc?.result ?? '').toLowerCase();
	if (dmarc === 'fail') {
		return false;
	}
	if (dmarc === 'pass') {
		return true;
	}

	const fromDomain = normalizeDomain(ar.dmarc?.from);
	if (fromDomain === '') {
		return false;
	}
	if (
		(ar.spf?.result ?? '').toLowerCase() === 'pass' &&
		domainsAlign(normalizeDomain(ar.spf?.mailfrom), fromDomain)
	) {
		return true;
	}
	for (const entry of ar.dkim) {
		if (
			entry.result.toLowerCase() === 'pass' &&
			domainsAlign(normalizeDomain(entry.d), fromDomain)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Relaxed DMARC alignment (RFC 7489 §3.1.1): authenticated and From domains
 * align only when they share the same PSL-derived Organizational Domain.
 * Reuse the DMARC predicate so public/private suffixes such as `co.uk` and
 * `github.io` cannot become cross-tenant ARC rescue boundaries.
 */
function domainsAlign(authDomain: string, fromDomain: string): boolean {
	return isSpfAligned(authDomain, fromDomain, 'relaxed');
}

/** Lowercase, trim, and drop a trailing root dot from a domain. */
export function normalizeDomain(domain: string | undefined): string {
	return (domain ?? '').trim().toLowerCase().replace(/\.$/, '');
}
