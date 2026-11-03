/**
 * Reading what a sender's domain publishes about its logo, and judging the
 * bytes it serves. Pure and V8-safe; `discover.ts` does the DNS and HTTP and
 * hands the answers here.
 *
 * Every input is attacker-controlled (anyone can pass DMARC for a domain they
 * own), so nothing here trusts a declared type: an image is kept only when
 * its bytes match an allowed format, and an SVG only when it carries no
 * script and no reference to anything outside itself.
 */

import { svgTextForms, workspaceLogoBytesProblem } from '@owlat/shared/workspaceLogo';

/** BIMI recommends logos well under this; anything bigger is not a logo. */
export const MAX_BIMI_LOGO_BYTES = 32 * 1024;
/** A site icon: an apple-touch-icon PNG is a few KB, a multi-size .ico tens. */
export const MAX_ICON_BYTES = 100 * 1024;

export type SenderLogoMimeType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/x-icon';

/** `tag=value` pairs of a DNS TXT record (DMARC and BIMI share the grammar). */
function recordTags(record: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const part of record.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim().toLowerCase();
		if (key && !tags.has(key)) tags.set(key, part.slice(eq + 1).trim());
	}
	return tags;
}

/**
 * Whether a domain's DMARC record enforces on all of its mail. BIMI is only
 * meaningful at `p=quarantine` or `p=reject` with no `pct` below 100: a
 * domain that only monitors has not committed to rejecting spoofs of its logo.
 */
export function isDmarcEnforcing(records: readonly string[]): boolean {
	const dmarc = records.filter((record) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(record.trim()));
	// RFC 7489: more than one record means no policy at all.
	if (dmarc.length !== 1) return false;
	const tags = recordTags(dmarc[0]!);
	const policy = tags.get('p')?.toLowerCase();
	if (policy !== 'quarantine' && policy !== 'reject') return false;
	const pct = tags.get('pct');
	return pct === undefined || pct === '100';
}

/**
 * The HTTPS logo URL of a BIMI assertion record, or `null` when there is no
 * single valid record or it declines to publish a logo (`l=` empty).
 */
export function bimiLogoUrl(records: readonly string[]): string | null {
	const bimi = records.filter((record) => /^v\s*=\s*BIMI1\s*(;|$)/i.test(record.trim()));
	if (bimi.length !== 1) return null;
	const location = recordTags(bimi[0]!).get('l');
	if (!location) return null;
	try {
		const url = new URL(location);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

/** The media type of a `content-type` header, lowercase, without parameters. */
export function mediaTypeOf(contentType: string | null): string {
	return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * An SVG that points outside itself would make whoever opens its storage URL
 * fetch from the sender's servers. Only references to a local `#fragment` are
 * allowed: an `href`/`src` or `url(…)` whose value starts with anything else
 * is refused. The fragment test is a lookahead right after `=` or `(`, so an
 * optional quote or space cannot be skipped to make `url("#g")` look external.
 *
 * CSS escapes can spell any name or scheme (`u\72l(`, `\68 ttps:`), so a
 * backslash anywhere refuses the file, as do `<style>` and `@import`; logo
 * markup needs none of them. `xmlns` values are names, not fetches, so they
 * pass. Tried on every form `svgTextForms` gives, so XML character references
 * (`&#104;ttps:`) are read the way the parser will.
 */
const EXTERNAL_SVG_REFERENCE: readonly RegExp[] = [
	/(?:href|src)\s*=(?!\s*["']?\s*#)/i,
	/url\((?!\s*["']?\s*#)/i,
	/\\/,
	/<(?:[\w.-]+:)?style[\s>/]/i,
	/@import/i,
];

function hasExternalReference(text: string): boolean {
	return svgTextForms(text).some((form) =>
		EXTERNAL_SVG_REFERENCE.some((pattern) => pattern.test(form))
	);
}

const ICO_SIGNATURE = [0x00, 0x00, 0x01, 0x00];

/**
 * The stored type for an image, or `null` when the bytes are not a safe image
 * of an allowed format. The declared media type picks the check; the bytes
 * decide. `svgOnly` is for BIMI, which publishes SVG and nothing else.
 */
export function acceptedLogoType(
	declared: string,
	bytes: Uint8Array,
	opts: { svgOnly?: boolean } = {}
): SenderLogoMimeType | null {
	if (bytes.length === 0) return null;
	if (declared === 'image/svg+xml') {
		if (workspaceLogoBytesProblem('image/svg+xml', bytes) !== null) return null;
		const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
		return hasExternalReference(text) ? null : 'image/svg+xml';
	}
	if (opts.svgOnly) return null;
	if (declared === 'image/png' || declared === 'image/jpeg') {
		return workspaceLogoBytesProblem(declared, bytes) === null ? declared : null;
	}
	if (declared === 'image/x-icon' || declared === 'image/vnd.microsoft.icon') {
		return ICO_SIGNATURE.every((byte, i) => bytes[i] === byte) ? 'image/x-icon' : null;
	}
	return null;
}
