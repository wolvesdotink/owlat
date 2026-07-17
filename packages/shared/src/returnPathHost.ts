/**
 * Validation + normalization for a per-domain VERP return-path host.
 *
 * A sending domain may register its own bounce/return-path host (the domain
 * part of the `bounce+…@` envelope MAIL FROM) instead of the global
 * `RETURN_PATH_DOMAIN`. That value is attacker-adjacent: it is threaded into the
 * SMTP envelope and into DNS/MX-facing strings, so it MUST be a strict,
 * injection-safe DNS FQDN before it is ever persisted or used.
 *
 * This is the SINGLE source of truth for return-path-host acceptance, shared by
 * the MTA (which validates the D1 register-endpoint body) and the Convex backend
 * (which validates the `setReturnPathHost` mutation + the atomic add-domain
 * path). The two sides MUST agree exactly: the Convex `asDnsName` primitive is
 * deliberately laxer (it accepts single labels like `localhost` and underscore
 * service labels like `_bounce.example.com`), so using it as the acceptance gate
 * let Convex persist values the MTA then rejects forever. Both sides call THIS
 * validator instead.
 *
 * We enforce RFC 1123 host syntax (§2.1): bounded total length (253 octets),
 * bounded per-label length (63), a dotted FQDN with a real (non-all-numeric)
 * TLD, and an allowed charset of `[a-z0-9-]` per label with no leading/trailing
 * hyphen. Anything carrying whitespace, `@`, `/`, a scheme, a port, control
 * characters, underscore service labels, or a single bare label is rejected —
 * those are exactly the shapes an injection payload or an unroutable host takes.
 */

/** RFC 1123 §2.1 — maximum total length of a hostname, in octets. */
const MAX_HOST_LENGTH = 253;

/** RFC 1035 §2.3.4 — maximum length of a single DNS label. */
const MAX_LABEL_LENGTH = 63;

/**
 * A single DNS label: 1–63 chars of `[a-z0-9-]`, never starting or ending with
 * a hyphen. (Case is normalized to lower-case before this is applied.) Interior
 * hyphens are allowed, including the `xn--` ACE prefix of an IDN/punycode label.
 * Underscores are intentionally excluded — a return-path host is a real
 * deliverable hostname, not a `_service` label.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * An all-numeric last label. The trailing label (TLD) must NOT be all-digits, so
 * a bare IPv4 literal (`10.0.0.5`) cannot masquerade as a return-path FQDN. We
 * deliberately do NOT require the TLD to be purely alphabetic: that would reject
 * every punycode/IDN TLD (`xn--p1ai`, `xn--80akhbyknj4f`, …).
 */
const ALL_NUMERIC = /^[0-9]+$/;

/**
 * Validate and normalize a candidate per-domain return-path host.
 *
 * Returns the lower-cased FQDN when it is a syntactically valid DNS hostname, or
 * `null` when it is not (garbage / injection / non-FQDN / single label /
 * underscore service label). Callers MUST treat a `null` result as a rejected
 * input, never as "use as-is".
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
	if (!tld || ALL_NUMERIC.test(tld)) return null;

	return host;
}

/** Whether a candidate return-path host is a valid, routable DNS FQDN. */
export function isValidReturnPathHost(input: unknown): boolean {
	return normalizeReturnPathHost(input) !== null;
}
