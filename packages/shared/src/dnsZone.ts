/**
 * Zone / Public-Suffix-List foundation shared between the Nuxt client (the
 * Add-Domain picker and the DNS record panel) and the Convex backend (domain
 * registration + DNS verification). Both sides must agree on:
 *
 *  - which part of a sending domain is the **registrable zone** the user manages
 *    at their DNS provider (`mail.example.com` → `example.com`), and
 *  - how a record's fully-qualified host should be written **relative to that
 *    zone** (`s171._domainkey.mail.example.com` in zone `example.com` →
 *    `s171._domainkey.mail`), because most providers paste names relative to the
 *    zone and copying the FQDN produces the classic `…mail.example.com.example.com`
 *    double-suffix that fails verification.
 *
 * ## Why `tldts` and not a trimmed PSL subset
 *
 * Splitting the registrable domain correctly requires the Public Suffix List:
 * a naive "last two labels" rule mis-splits every multi-label suffix
 * (`example.co.uk` → `co.uk`, `example.gov.au` → `gov.au`, …) and Owlat lets
 * users bring an *arbitrary* domain under *any* suffix. This same module runs the
 * Convex verifier, where a wrong registrable domain means the wrong DNS lookup
 * target and a domain that never verifies — the precise bug this work exists to
 * fix. A hand-trimmed suffix subset would silently corrupt any domain under an
 * omitted suffix, on the client *and* the server, and the card forbids environment
 * coupling so we cannot ship "full PSL on the server, trimmed on the client".
 * `tldts` (~40 kB gzipped) carries the full compiled PSL, is pure and isomorphic
 * (no Node- or browser-only APIs), and is *already resolved in the lockfile* as a
 * transitive dependency of `mailauth@7.0.30`, so promoting it to a direct
 * dependency of `@owlat/shared` adds no new package to the tree. Correctness wins
 * the bundle-size trade-off for a one-time DNS-setup surface.
 *
 * Isomorphism note: IDN → punycode normalization uses the WHATWG `URL` parser,
 * which is a global in the browser, in Convex's default runtime, and in Node
 * `"use node"` actions — no `node:punycode`, no browser-only APIs.
 */

import { parse as parseTldts } from 'tldts';

/**
 * A validated, normalized DNS name: lowercase, no trailing dot, IDN labels in
 * punycode (`xn--…`). Branded so downstream pieces pass a value that has already
 * been through {@link asDnsName} / {@link splitZone} instead of a raw string,
 * heading off Primitive Obsession. It is a plain `string` at runtime, so it
 * crosses the Convex wire and copies into the DOM with no ceremony.
 */
export type DnsName = string & { readonly __brand: 'DnsName' };

/** The result of splitting a domain into its registrable zone and the labels below it. */
export interface ZoneSplit {
	/**
	 * The registrable domain (eTLD+1, ICANN section) — the zone the user manages
	 * at their DNS provider. Always normalized: `example.com`, `example.co.uk`.
	 */
	readonly registrable: DnsName;
	/**
	 * Labels below the registrable domain, in FQDN order (the outermost sending
	 * label last). Empty for an apex domain. For `a.b.example.co.uk` this is
	 * `['a', 'b']`.
	 */
	readonly subLabels: readonly string[];
	/**
	 * {@link subLabels} joined with `.`, or `''` for an apex domain. Convenience
	 * for the sending-subdomain picker, whose input is a single string.
	 */
	readonly sub: string;
}

/** Thrown by {@link splitZone} and {@link zoneRelativeHost} for input with no registrable domain. */
export class InvalidDomainError extends Error {
	constructor(
		message: string,
		/** The offending input, for callers that log or surface it. */
		readonly input: string
	) {
		super(message);
		this.name = 'InvalidDomainError';
	}
}

// Characters that must never appear in a bare domain/host. The WHATWG URL parser
// silently truncates on `/` (treating the rest as a path) and would accept a
// port after `:`, so we reject these up front rather than let a mangled hostname
// through.
const FORBIDDEN_INPUT = /[\s/\\@:?#%]/;

// A single lax DNS name label as it appears on the wire: 1–63 octets of
// letters/digits/hyphen plus the leading underscore used by service labels
// (`_dmarc`, `_domainkey`, `_smtp`). Hyphens may not lead or trail. This is
// deliberately laxer than isDnsLabel(), which is the strict *hostname* rule for
// user-chosen subdomains and rejects underscores.
const LAX_LABEL = /^_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalize a raw domain/host string to a {@link DnsName}, or `null` if it is not
 * a usable DNS name. Normalization: trim, drop a single trailing dot, lowercase,
 * and IDNA-encode Unicode labels to punycode via the WHATWG `URL` parser. Every
 * resulting label must be a non-empty, ≤63-octet wire label; anything else
 * (empty labels from `a..b`, spaces, paths, IP literals of the wrong shape, …)
 * yields `null`.
 */
export function asDnsName(raw: string): DnsName | null {
	if (typeof raw !== 'string') return null;
	let value = raw.trim();
	if (value === '') return null;
	// Strip a single trailing dot (absolute-name form) before the forbidden check.
	if (value.endsWith('.')) value = value.slice(0, -1);
	if (value === '' || FORBIDDEN_INPUT.test(value)) return null;

	let hostname: string;
	try {
		hostname = new URL(`http://${value}`).hostname;
	} catch {
		return null;
	}
	if (hostname === '' || hostname.includes('%')) return null;
	// URL keeps a trailing dot and does not touch case for already-ASCII input.
	if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
	hostname = hostname.toLowerCase();

	const labels = hostname.split('.');
	if (labels.length === 0) return null;
	for (const label of labels) {
		if (!LAX_LABEL.test(label)) return null;
	}
	return hostname as DnsName;
}

/**
 * Validate a single DNS **hostname** label (RFC 1123 preferred syntax): 1–63
 * characters of ASCII letters, digits and hyphens, with no leading or trailing
 * hyphen. Case-insensitive; punycode `xn--…` labels pass because they are pure
 * letter-digit-hyphen. Underscores are rejected on purpose — this backs the
 * Add-Domain subdomain picker, where a user-chosen sending label such as `mail`
 * or `post` must be a real hostname label, not a `_service` label.
 */
export function isDnsLabel(label: string): boolean {
	if (typeof label !== 'string') return false;
	if (label.length < 1 || label.length > 63) return false;
	if (!/^[a-z0-9-]+$/i.test(label)) return false;
	if (label.startsWith('-') || label.endsWith('-')) return false;
	return true;
}

/**
 * Split a domain into its registrable zone and the labels below it.
 *
 * `mail.example.com` → `{ registrable: 'example.com', subLabels: ['mail'], sub: 'mail' }`
 * `example.co.uk`    → `{ registrable: 'example.co.uk', subLabels: [], sub: '' }`
 *
 * @throws {InvalidDomainError} when the input has no registrable domain — an
 * empty/garbage string, a bare public suffix (`co.uk`), a single label
 * (`localhost`), or an IP literal. Use {@link trySplitZone} for the non-throwing
 * variant (e.g. live-validating picker input).
 */
export function splitZone(domain: string): ZoneSplit {
	const split = trySplitZone(domain);
	if (split === null) {
		throw new InvalidDomainError(
			`"${domain}" has no registrable domain (needs a registrable name under a public suffix)`,
			domain
		);
	}
	return split;
}

/**
 * Non-throwing {@link splitZone}: returns the {@link ZoneSplit} or `null` when the
 * input has no registrable domain. Backs paste-a-full-domain parsing in the
 * Add-Domain picker, which re-parses `mail.example.com` into a domain + subdomain
 * rather than rejecting it.
 */
export function trySplitZone(domain: string): ZoneSplit | null {
	const name = asDnsName(domain);
	if (name === null) return null;

	// allowPrivateDomains:false → registrable is the ICANN eTLD+1 (the zone the
	// user actually controls at their registrar), so `foo.blogspot.com` splits at
	// `blogspot.com`, not the PSL private entry.
	const parsed = parseTldts(name);
	const registrable = parsed.domain;
	if (registrable === null || parsed.isIp) return null;

	const registrableName = registrable as DnsName;
	const subLabels =
		name === registrableName
			? []
			: name.slice(0, name.length - registrableName.length - 1).split('.');
	return { registrable: registrableName, subLabels, sub: subLabels.join('.') };
}

/**
 * Render a record's fully-qualified host **relative to the registrable zone** of
 * `domain`, as most DNS providers expect the name to be pasted.
 *
 * zone `example.com`, host `s171._domainkey.mail.example.com` → `s171._domainkey.mail`
 * host equal to the zone apex                                  → `@`
 *
 * When `recordHost` is not inside the registrable zone (e.g. a shared return-path
 * host like `bounces.owlat.com` under a customer zone `example.com`), it cannot be
 * made relative, so its absolute form is returned **with a trailing dot** — the
 * DNS convention for a fully-qualified name — signalling "paste this verbatim,
 * it does not belong to your zone".
 *
 * @throws {InvalidDomainError} when `domain` has no registrable zone, or when
 * `recordHost` is not a usable DNS name.
 */
export function zoneRelativeHost(recordHost: string, domain: string): string {
	const zone = splitZone(domain).registrable;
	const host = asDnsName(recordHost);
	if (host === null) {
		throw new InvalidDomainError(`"${recordHost}" is not a valid DNS name`, recordHost);
	}

	if (host === zone) return '@';
	if (host.endsWith(`.${zone}`)) {
		return host.slice(0, host.length - zone.length - 1);
	}
	// Out of zone: fully-qualified, not relative to `domain`'s registrable zone.
	return `${host}.`;
}
