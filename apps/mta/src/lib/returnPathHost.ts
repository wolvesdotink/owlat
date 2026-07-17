/**
 * Validation + normalization for a per-domain VERP return-path host.
 *
 * A sending domain may register its own bounce/return-path host (the domain
 * part of the `bounce+…@` envelope MAIL FROM) instead of the global
 * `RETURN_PATH_DOMAIN`. That value is attacker-adjacent: it is threaded into the
 * SMTP envelope and into DNS/MX-facing strings, so it MUST be a strict,
 * injection-safe DNS FQDN before it is ever persisted or used.
 *
 * We enforce RFC 1123 host syntax (§2.1) rather than lean on a loose domain
 * regex: bounded total length (253 octets), bounded per-label length (63), a
 * dotted FQDN with a real TLD, and an allowed charset of `[a-z0-9-]` per label
 * with no leading/trailing hyphen. Anything carrying whitespace, `@`, `/`, a
 * scheme, a port, control characters, or other envelope/DNS metacharacters is
 * rejected — those are exactly the shapes an injection payload would take.
 */

/** RFC 1123 §2.1 — maximum total length of a hostname, in octets. */
const MAX_HOST_LENGTH = 253;

/** RFC 1035 §2.3.4 — maximum length of a single DNS label. */
const MAX_LABEL_LENGTH = 63;

/**
 * A single DNS label: 1–63 chars of `[a-z0-9-]`, never starting or ending with
 * a hyphen. (Case is normalized to lower-case before this is applied.)
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The trailing label (TLD) must be alphabetic and at least two chars, so a bare
 * IP address or a single-label host cannot masquerade as a return-path FQDN.
 */
const TLD = /^[a-z]{2,}$/;

/**
 * Validate and normalize a candidate per-domain return-path host.
 *
 * Returns the lower-cased FQDN when it is a syntactically valid DNS hostname, or
 * `null` when it is not (garbage / injection / non-FQDN). Callers MUST treat a
 * `null` result as a rejected input, never as "use as-is".
 *
 * @param input the untrusted registration value (may be any type at runtime)
 */
export function normalizeReturnPathHost(input: unknown): string | null {
	if (typeof input !== 'string') return null;

	// Trim surrounding whitespace, drop a single trailing dot (root label), and
	// lower-case for DNS case-insensitivity. Any INTERIOR whitespace survives and
	// is rejected by the label charset below.
	const host = input.trim().replace(/\.$/, '').toLowerCase();

	if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;

	const labels = host.split('.');
	// A return-path host must be a dotted FQDN (at least a name + a TLD).
	if (labels.length < 2) return null;

	for (const label of labels) {
		if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
		if (!LABEL.test(label)) return null;
	}

	const tld = labels[labels.length - 1];
	if (!tld || !TLD.test(tld)) return null;

	return host;
}

/**
 * Whether a candidate return-path host is a valid DNS FQDN.
 */
export function isValidReturnPathHost(input: unknown): boolean {
	return normalizeReturnPathHost(input) !== null;
}
