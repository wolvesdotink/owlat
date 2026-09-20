/**
 * De-identify email addresses and subjects before they reach a process log.
 *
 * Process logs (Convex's function log, the sidecars' pino stdout) are not the
 * product: they get shipped to whatever aggregator the operator points at, are
 * read by people with no mail-content grant, and outlive the message they
 * describe. Everything here is about that pipe only — `auditLogs`, delivery
 * logs and anything else deliberately persisted for the UI is untouched.
 *
 * Why a hash and not a flat `[redacted]`: the single thing an operator does
 * with these lines is correlate them — "the message we bounced at the MTA is
 * the one Convex refused as a duplicate", "these 400 deferrals are all the same
 * recipient". A constant censor destroys that. A stable digest keeps it.
 *
 * Why the digest is unsalted, and what that does and does not buy: a per-process
 * salt would make the token unguessable, and would also make it useless — the
 * MTA line and the Convex line for the same recipient would no longer match,
 * and neither would two lines from either side of a restart. So the digest is a
 * pure function of the address. The honest consequence is that this is
 * de-identification, not anonymisation: an address is low-entropy, so anyone
 * holding both a log and a candidate list can confirm a guess by hashing it.
 * What it does buy is that the plaintext address is no longer *in* the log —
 * a leaked log file, a shared screenshot, a third-party aggregator index or a
 * support engineer reading along cannot read the correspondent off the line.
 *
 * The domain is kept in the clear on purpose. It is the part operators route on
 * (which tenant, which receiving provider, which forwarder) and it identifies a
 * host, not a person.
 */

/**
 * FNV-1a, 64-bit. Non-cryptographic and deliberately so: this runs on every
 * logged line in the MTA's hot path, must be synchronous (WebCrypto's digest is
 * not) and must work unchanged in a browser bundle, a Convex isolate and Bun.
 * The security property being claimed is "not readable", which preimage
 * resistance would not provide for an input this small anyway (see above); what
 * is actually needed is a wide, stable, cheap, collision-sparse token.
 */
function fnv1a64Hex(input: string): string {
	const prime = 0x100000001b3n;
	const mask = 0xffffffffffffffffn;
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i++) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, '0');
}

/** Digest width in hex chars. 12 → 48 bits, ~2e7 addresses before a 50% collision. */
const DIGEST_HEX = 12;

/** Stable token for an arbitrary string. Exported for callers with their own shapes. */
export function redactionDigest(value: string): string {
	return fnv1a64Hex(value).slice(0, DIGEST_HEX);
}

/**
 * `marcel@example.com` → `redacted-4f3a1c92b7d0@example.com`.
 *
 * The result is shaped like an address so structured log consumers that expect
 * one do not choke, and prefixed so nobody mistakes it for a deliverable one.
 * Input is lowercased and trimmed before hashing so the same mailbox written
 * three ways correlates to one token.
 *
 * A value with no `@` is not an address; it is hashed whole and returned as
 * `redacted-<digest>` rather than being guessed at.
 */
export function redactEmailAddress(address: string): string {
	const normalized = address.trim().toLowerCase();
	if (normalized.length === 0) return '';
	const at = normalized.lastIndexOf('@');
	const digest = redactionDigest(normalized);
	if (at <= 0 || at === normalized.length - 1) return `redacted-${digest}`;
	return `redacted-${digest}@${normalized.slice(at + 1)}`;
}

/** Redact each address in a list, preserving order and length. */
export function redactEmailAddresses(addresses: readonly string[]): string[] {
	return addresses.map(redactEmailAddress);
}

/**
 * `Re: invoice 4012 overdue` → `[subject len=25 4f3a1c92b7d0]`.
 *
 * Subjects carry more than the address does — they are user-written prose and
 * routinely contain names, invoice numbers and case references — so nothing of
 * the text survives. The length is kept because it is the one property that
 * helps triage (empty subject, absurdly long subject) without describing
 * content, and the digest keeps the same subject correlatable across hops.
 */
export function redactSubject(subject: string): string {
	return `[subject len=${subject.length} ${redactionDigest(subject)}]`;
}
