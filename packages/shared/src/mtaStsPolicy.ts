/**
 * MTA-STS policy publishing (RFC 8461) — pure serializer for the operator's OWN
 * SMTP MTA Strict Transport Security policy.
 *
 * Owlat's MTA already *enforces* other domains' MTA-STS when sending outbound
 * (apps/mta/src/smtp/mtaSts.ts). This is the reciprocal, receiving side: it lets
 * the operator PUBLISH their own policy so that senders delivering TO this
 * deployment are told to require TLS with a verified certificate on the MX host.
 *
 * A published MTA-STS policy has two DNS/HTTPS parts:
 *
 *   1. A TXT record at `_mta-sts.<domain>` announcing a policy exists and a
 *      short `id` that changes whenever the policy changes (so senders know to
 *      re-fetch). {@link buildMtaStsTxtValue} + {@link mtaStsPolicyId}.
 *   2. The policy file itself, served over HTTPS at
 *      `https://mta-sts.<domain>/.well-known/mta-sts.txt` with a `text/plain`
 *      content type. {@link buildMtaStsPolicy}.
 *
 * This module is DOM- and DB-free (pure primitives in, plain strings out) so the
 * serializer is unit-testable without a browser or the Convex client, and is the
 * single source of truth shared by the Convex policy query, the Nuxt policy
 * route, and the DNS-guidance UI.
 */

/**
 * The operator's MTA-STS posture, in ascending strictness. Mirrors the RFC 8461
 * `mode` values plus "none" for "don't publish a policy at all".
 *
 *  - `none`     — no policy is published (the default; byte-identical to today).
 *  - `testing`  — the policy is published but failures are only reported, never
 *    enforced (RFC 8461 §5). The safe first step: senders keep delivering even
 *    if TLS can't be verified, so a misconfiguration can't blackhole inbound
 *    mail while the operator watches TLS-RPT.
 *  - `enforce`  — senders MUST deliver over verified TLS to a listed MX or fail
 *    the delivery (RFC 8461 §5). Turn on only once `testing` looks clean.
 */
export type MtaStsMode = 'none' | 'testing' | 'enforce';

/** The valid {@link MtaStsMode} values, in strictness order (stepper order). */
export const MTA_STS_MODES: readonly MtaStsMode[] = ['none', 'testing', 'enforce'] as const;

/** The published (non-`none`) MTA-STS modes — the ones that emit a policy body. */
export type MtaStsPublishedMode = 'testing' | 'enforce';

/** Narrow an untrusted string to a valid {@link MtaStsMode}. */
export function isMtaStsMode(value: string): value is MtaStsMode {
	return (MTA_STS_MODES as readonly string[]).includes(value);
}

/**
 * Policy `max_age` in seconds — how long a sender may cache this policy (RFC 8461
 * §3.2). One week is the widely-used default (Google, Microsoft): long enough to
 * resist a stripping attack, short enough to recover from a mistake.
 */
export const MTA_STS_MAX_AGE_SECONDS = 604800;

/** DNS label for the MTA-STS policy TXT record (RFC 8461 §3.1): `_mta-sts`. */
export const MTA_STS_TXT_HOST = '_mta-sts';

/** DNS label for the policy-hosting subdomain (RFC 8461 §3.2): `mta-sts`. */
export const MTA_STS_POLICY_HOST = 'mta-sts';

/** The well-known path the policy file is served at (RFC 8461 §3.2). */
export const MTA_STS_WELL_KNOWN_PATH = '/.well-known/mta-sts.txt';

/** The content type the policy file MUST be served with (RFC 8461 §3.2). */
export const MTA_STS_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Canonical string for one (mode, MX set): the mode followed by the MX hosts
 * lowercased, de-duplicated and sorted. Order- and case-insensitive so the same
 * logical policy always hashes to the same id.
 */
function canonicalPolicyKey(mode: MtaStsPublishedMode, mx: readonly string[]): string {
	const hosts = [...new Set(mx.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
	return `${mode}\n${hosts.join(',')}`;
}

/**
 * FNV-1a 32-bit hash of a string → unsigned 32-bit integer. A tiny, dependency-
 * free, deterministic hash — the policy id only needs to change iff its input
 * changes, not to be cryptographic.
 */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// FNV prime 16777619, kept in 32-bit unsigned range via Math.imul + >>> 0.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * Derive the RFC 8461 policy `id` for a (mode, MX set) — a short alphanumeric
 * token that CHANGES if and only if the mode or the MX set changes, so senders
 * re-fetch the policy exactly when it has actually changed. Deterministic and
 * pure; independent of MX order or case.
 *
 * The id is a 16-hex-char digest (two FNV-1a passes over the canonical key and
 * its reverse) — well within the RFC's `1*32(ALPHA / DIGIT)` limit.
 */
export function mtaStsPolicyId(mode: MtaStsPublishedMode, mx: readonly string[]): string {
	const key = canonicalPolicyKey(mode, mx);
	const a = fnv1a(key).toString(16).padStart(8, '0');
	const b = fnv1a([...key].reverse().join(''))
		.toString(16)
		.padStart(8, '0');
	return `${a}${b}`;
}

/**
 * Build the `_mta-sts.<domain>` TXT record value (RFC 8461 §3.1):
 * `v=STSv1; id=<policyId>`.
 */
export function buildMtaStsTxtValue(policyId: string): string {
	return `v=STSv1; id=${policyId}`;
}

/**
 * Parse the `id=` value out of an observed `_mta-sts` TXT record. Tolerant of
 * tag order and surrounding whitespace (RFC 8461 §3.1 is a `;`-delimited
 * key/value list); returns `null` when the record isn't a valid STSv1 record or
 * carries no id.
 */
export function parseMtaStsTxtId(txtValue: string): string | null {
	const parts = txtValue.split(';').map((part) => part.trim());
	if (!parts.some((part) => part.toLowerCase() === 'v=stsv1')) return null;
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		if (part.slice(0, eq).trim().toLowerCase() === 'id') {
			const id = part.slice(eq + 1).trim();
			return id || null;
		}
	}
	return null;
}

/** The result of checking a published MTA-STS policy against what we expect. */
export interface MtaStsVerification {
	/** The `_mta-sts` TXT record carries a `v=STSv1; id=…` with our current id. */
	txtRecordValid: boolean;
	/** The HTTPS-served policy body is byte-identical to the one we generate. */
	policyServedValid: boolean;
	/** Both halves check out — the policy is fully, correctly published. */
	verified: boolean;
	/** The id we expect the TXT record to carry (this deployment's current id). */
	expectedId: string;
	/** The id actually observed in the TXT record, when parseable. */
	observedId: string | null;
}

/**
 * Verify an observed MTA-STS publication against the policy this deployment
 * currently generates: the TXT record must announce our current policy id
 * (RFC 8461 §3.1) AND the HTTPS-served body must match ours exactly (§3.2). Pure
 * — the caller does the DNS/HTTPS gathering and passes the raw observations in,
 * so the id-match logic is unit-testable without a network.
 */
export function verifyMtaStsPublication(
	expected: { policyId: string; body: string },
	observed: { txtValue?: string | null; servedBody?: string | null }
): MtaStsVerification {
	const observedId = observed.txtValue ? parseMtaStsTxtId(observed.txtValue) : null;
	const txtRecordValid = observedId !== null && observedId === expected.policyId;
	const policyServedValid = (observed.servedBody ?? null) === expected.body;
	return {
		txtRecordValid,
		policyServedValid,
		verified: txtRecordValid && policyServedValid,
		expectedId: expected.policyId,
		observedId,
	};
}

/**
 * Build the MTA-STS policy file body served at `/.well-known/mta-sts.txt`
 * (RFC 8461 §3.2). CRLF line endings per the spec's ABNF. One `mx` line per MX
 * host; hosts are lowercased, de-duplicated and sorted so the body is stable for
 * a given logical policy.
 *
 * `mode` is a PUBLISHED mode (`testing` | `enforce`) — `none` means no policy is
 * published, so there is no body to build and callers must not reach here with
 * it.
 */
export function buildMtaStsPolicy(mode: MtaStsPublishedMode, mx: readonly string[]): string {
	const hosts = [...new Set(mx.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
	const lines = ['version: STSv1', `mode: ${mode}`];
	for (const host of hosts) {
		lines.push(`mx: ${host}`);
	}
	lines.push(`max_age: ${MTA_STS_MAX_AGE_SECONDS}`);
	// RFC 8461 §3.2 ABNF terminates each line with CRLF.
	return lines.map((line) => `${line}\r\n`).join('');
}
