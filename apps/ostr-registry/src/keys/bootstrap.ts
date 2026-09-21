/**
 * The §4.2 bootstrap allowlist: an explicit, published set of seed observers,
 * named for what it is.
 *
 * Observer standing is defined by corroboration against other observers (§6.3),
 * which is circular at genesis — the first observer has nobody to be
 * corroborated by. Phases 0–2 therefore run on an editorial trust anchor: a
 * list of seed observers the operator publishes, and no others. It must sunset
 * into earned standing by Phase 3; a bootstrap anchor pretending to be emergent
 * consensus would be hidden centralization, which is the thing this design
 * exists to remove.
 *
 * Two consequences are deliberate:
 *
 * - The allowlist gates SUBMISSION, not scoring. An unlisted observer's
 *   attestation is refused at the door with `unknown observer key`; nothing in
 *   the log is weighted by membership, because a score favour for being on a
 *   list is exactly the pay-with-data the policy bars (§11).
 * - Enforcement lives in the key directory, which is the only seam the log
 *   consults about an observer. That keeps `SqliteRegistryLog` content-neutral
 *   and unaware that an allowlist exists, and it means turning the allowlist
 *   off is a configuration change, not a code path.
 *
 * Keys stay in DNS by default — a listed observer still publishes and rotates
 * at `_ostr.<domain>` like everyone else. Inline `domain=key` pairs pin a seed
 * observer's key instead, for a private federation standing up before its DNS
 * does; a pinned observer is never resolved.
 */
import type { KeyDirectory } from '../contracts.js';
import { normalizeObserverDomain, StaticKeyDirectory, toKeyRecord } from './static.js';

/** One entry of the published allowlist. */
export interface BootstrapObserver {
	/** Normalized observer domain. */
	domain: string;
	/** Pinned `_ostr` records. Empty means "resolve this observer via DNS". */
	records: readonly string[];
}

/**
 * Parse the published allowlist from its configured form: entries separated by
 * commas or whitespace, each either `domain` or `domain=<key or record>`.
 * Repeating a domain merges its pinned keys, which is how a seed observer
 * rotates without a flag day.
 *
 * Throws on anything unusable. An operator who fat-fingers one entry of an
 * allowlist has silently un-listed an observer, and the symptom — one node
 * rejecting one federation member's submissions — is otherwise found by
 * whoever notices the evidence went missing.
 */
export function parseBootstrapObservers(value: string): BootstrapObserver[] {
	const byDomain = new Map<string, string[]>();
	for (const raw of value.split(/[\s,]+/)) {
		const entry = raw.trim();
		if (entry === '') continue;
		const at = entry.indexOf('=');
		const domain = normalizeObserverDomain(at < 0 ? entry : entry.slice(0, at));
		if (domain === null) {
			throw new Error(`bootstrap observers: "${entry}" does not start with a domain name`);
		}
		const records = byDomain.get(domain) ?? [];
		if (at >= 0) {
			try {
				records.push(toKeyRecord(entry.slice(at + 1)));
			} catch (error) {
				throw new Error(`bootstrap observers: ${domain}: ${(error as Error).message}`);
			}
		}
		byDomain.set(domain, records);
	}
	if (byDomain.size === 0) {
		throw new Error('bootstrap observers: the list is set but names no observer');
	}
	return [...byDomain].map(([domain, records]) => ({ domain, records: [...new Set(records)] }));
}

/**
 * A {@link KeyDirectory} that answers only for allowlisted observers: pinned
 * records where the allowlist carried them, `fallback` (DNS) otherwise, and
 * nothing at all for anyone else.
 */
export class AllowlistKeyDirectory implements KeyDirectory {
	readonly #allowed: Set<string>;
	readonly #pinned: StaticKeyDirectory;
	readonly #fallback: KeyDirectory;

	constructor(observers: readonly BootstrapObserver[], fallback: KeyDirectory) {
		if (observers.length === 0) {
			// An empty allowlist accepts nobody. That is a configuration mistake
			// with the shape of a working node: it starts, it serves, and every
			// submission is refused.
			throw new Error('bootstrap allowlist: at least one observer is required');
		}
		this.#allowed = new Set<string>();
		const pinned: Record<string, readonly string[]> = {};
		for (const observer of observers) {
			const domain = normalizeObserverDomain(observer.domain);
			if (domain === null) {
				throw new Error(`bootstrap allowlist: "${observer.domain}" is not a domain name`);
			}
			this.#allowed.add(domain);
			if (observer.records.length > 0) pinned[domain] = observer.records;
		}
		this.#pinned = new StaticKeyDirectory(pinned);
		this.#fallback = fallback;
	}

	/** The published list, sorted — an operator surface and the README's example. */
	observers(): string[] {
		return [...this.#allowed].sort();
	}

	async verifyingKeys(observerDomain: string): Promise<string[]> {
		const domain = normalizeObserverDomain(observerDomain);
		if (domain === null || !this.#allowed.has(domain)) return [];
		const pinned = await this.#pinned.verifyingKeys(domain);
		return pinned.length > 0 ? pinned : this.#fallback.verifyingKeys(domain);
	}
}
