/**
 * A {@link KeyDirectory} over keys the operator configured by hand, plus the
 * two small normalizations every directory in this module shares.
 *
 * This is the directory a test, an air-gapped replay or a bootstrap deployment
 * with inline keys uses: no DNS, no clock, no cache — a map. It exists next to
 * {@link DnsKeyDirectory} because the log must be able to run with key
 * discovery pinned, and because §4.2's bootstrap allowlist is allowed to carry
 * the seed observers' keys inline (the allowlist is published editorial trust;
 * pretending it was discovered would hide that).
 *
 * Records, not keys, are what a directory hands back: `selectVerifyingKey`
 * parses `_ostr` TXT records, and one shape all the way through means a static
 * directory and a DNS one cannot disagree about what a "key" is. Configuration
 * may spell an entry either way — a raw base64 public key is the convenient
 * form to paste — and {@link toKeyRecord} normalizes both into the record form,
 * which also collapses two spellings of one key into one string.
 */
import { formatOstrKeyRecord, isEd25519Key, isFqdn, parseOstrKeyRecord } from '@owlat/ostr-core';
import type { KeyDirectory } from '../contracts.js';

/**
 * The lookup form of an observer domain — lowercased, trimmed, no trailing dot
 * — or null when it is not a domain name at all.
 *
 * Attestations carry an already-validated lowercase FQDN, so in production this
 * only ever normalizes operator configuration; the null branch is what keeps a
 * junk observer from becoming a DNS query.
 */
export function normalizeObserverDomain(domain: string): string | null {
	const name = domain.trim().toLowerCase().replace(/\.+$/, '');
	return isFqdn(name) ? name : null;
}

/**
 * The `_ostr` TXT record for a configured key, accepting either a raw base64
 * ed25519 public key or an already-formatted record. Throws on anything else:
 * a key an operator meant to pin, silently dropped, is a directory that answers
 * "unknown observer" for the one observer it was configured for.
 */
export function toKeyRecord(value: string): string {
	const text = value.trim();
	if (isEd25519Key(text)) return formatOstrKeyRecord(text);
	const parsed = parseOstrKeyRecord(text);
	if (parsed.ok) return formatOstrKeyRecord(parsed.publicKeyBase64);
	return failKey(parsed.errors);
}

function failKey(errors: readonly string[]): never {
	throw new Error(
		`not a raw base64 ed25519 public key, and not a usable _ostr TXT record (${errors.join('; ')})`
	);
}

/** Domain to published records, both already normalized. */
export type StaticKeyEntries = Readonly<Record<string, readonly string[]>>;

/**
 * A fixed directory. Unlisted domains answer with no keys, which the log reads
 * as `unknown observer key` — a rejection, never an outage.
 */
export class StaticKeyDirectory implements KeyDirectory {
	readonly #records: Map<string, readonly string[]>;

	constructor(entries: StaticKeyEntries) {
		this.#records = new Map();
		for (const [domain, keys] of Object.entries(entries)) {
			const name = normalizeObserverDomain(domain);
			if (name === null) throw new Error(`key directory: "${domain}" is not a domain name`);
			const records = keys.map((key) => {
				try {
					return toKeyRecord(key);
				} catch (error) {
					throw new Error(`key directory: ${name}: ${(error as Error).message}`);
				}
			});
			this.#records.set(name, [...new Set([...(this.#records.get(name) ?? []), ...records])]);
		}
	}

	/** The domains this directory can answer for, in configuration order. */
	domains(): string[] {
		return [...this.#records.keys()];
	}

	async verifyingKeys(observerDomain: string): Promise<string[]> {
		const name = normalizeObserverDomain(observerDomain);
		if (name === null) return [];
		return [...(this.#records.get(name) ?? [])];
	}
}
