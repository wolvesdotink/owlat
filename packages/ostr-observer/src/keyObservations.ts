/**
 * Key observations (plan §7.5) — evidence durability.
 *
 * "Verifiable by anyone with DNS access" is only true near receipt time. DKIM
 * keys are rotated out of DNS as hygiene, and some senders deliberately publish
 * retired private keys to make old signatures deniable; both are legitimate, and
 * both destroy naive challenge-time verification. So the first time an observer
 * verifies a signature with a given (domain, selector, key) it publishes a
 * `key-observation`: the key as seen, whether the DNS chain was DNSSEC-validated,
 * and the span it has been in use. Challenges are then adjudicated against the
 * logged, multi-observer key record contemporaneous with receipt — never against
 * live DNS — and the log's own sequencing bounds when evidence could have been
 * fabricated.
 *
 * The corollary matters as much as the mechanism: because durability lives in
 * the log rather than in DNS persistence, frequent rotation costs a sender
 * nothing evidentially, which is why "stable keys" is deliberately not a scoring
 * signal (§6.2). A rotation is simply a new key with its own first observation.
 *
 * Emission is rate-limited to at most one attestation per key per window: after
 * the first, all a later observation adds is a fresher `lastSeen`, and a log
 * entry per verified message would be a per-message record in a public log —
 * the one thing §7.4 forbids.
 *
 * The rate limit is stated as DISJOINTNESS, not as window equality: an
 * attestation is drafted only when the new window starts at or after the end of
 * the last emitted one. Equality alone would bound emissions per distinct
 * window value rather than per unit of time, and a caller passing the obvious
 * rolling window — `{ from: dayStart, to: now }`, a fresh `to` on every message
 * — would get exactly the per-message public record this rule exists to
 * prevent.
 *
 * The single exception is a SPELLING UPGRADE: a key first seen only as
 * `sha256:<hex>` and later resolved to its SPKI DER emits again, because a
 * digest cannot re-verify a signature and the whole point of §7.5 is that the
 * log stays adjudicable after the key has left DNS.
 */
import {
	compareRfc3339,
	isChronological,
	isDkimSelector,
	isRfc3339,
	normalizeObservedKey,
	type AttestationWindow,
	type KeyObservationBody,
} from '@owlat/ostr-core';
import { normalizeDomain, type AttestationDraft } from './types.js';

/** What the observer remembers about one (domain, selector, key). */
export interface KeyObservationRecord {
	domain: string;
	selector: string;
	/** Comparable key identity: `sha256:<hex>`, from `normalizeObservedKey`. Two
	 *  observers that saw one key agree on this even when one logged the SPKI
	 *  and the other its digest. */
	keyId: string;
	/** The spelling published in the body — the SPKI DER (base64) whenever the
	 *  resolver gave one, because a digest cannot re-verify a signature. */
	publicKey: string;
	firstSeen: string;
	lastSeen: string;
	/** True once the key has been seen under a DNSSEC-validated chain. */
	dnssecValidated: boolean;
	/** `window.to` of the window an attestation was last emitted for. */
	lastEmittedWindowTo?: string;
}

/**
 * The observer's key memory. Synchronous, like the dedupe store: it is read on
 * the verification path, and an app backed by an async store keeps the working
 * set in memory and writes through in `put`.
 */
export interface KeyObservationStore {
	/** `domain` and `selector` arrive folded to lowercase — the tracker folds
	 *  them once, and a store that folds again changes nothing. */
	get(domain: string, selector: string, keyId: string): KeyObservationRecord | null | undefined;
	put(record: KeyObservationRecord): void;
}

export interface KeyObservationInput {
	/** The signature's `d=`. */
	domain: string;
	/** The signature's `s=`. */
	selector: string;
	/** Base64 SPKI DER of the DKIM public key (preferred) or `sha256:<hex>`. */
	publicKey: string;
	/** Whether the `<selector>._domainkey.<domain>` lookup validated. */
	dnssecValidated: boolean;
	/** RFC 3339 UTC instant of this verification. */
	seenAt: string;
}

export type KeyObservationRefusal =
	| 'invalid-domain'
	| 'invalid-selector'
	| 'unusable-public-key'
	| 'invalid-seen-at'
	| 'invalid-window';

/** Why a draft was or was not produced — the operator-visible half. */
export type KeyObservationDisposition =
	| 'first-observation'
	| 'window-update'
	/** The stored key was a digest and this observation carried the SPKI: the
	 *  record and the log are upgraded to the spelling that can re-verify a
	 *  signature, regardless of the emission rate limit. */
	| 'public-key-upgraded'
	| 'already-emitted-this-window';

export type KeyObservationResult =
	| {
			ok: true;
			record: KeyObservationRecord;
			draft: AttestationDraft<KeyObservationBody> | null;
			disposition: KeyObservationDisposition;
	  }
	| { ok: false; reason: KeyObservationRefusal };

function earliest(a: string, b: string): string {
	return compareRfc3339(a, b) <= 0 ? a : b;
}

function latest(a: string, b: string): string {
	return compareRfc3339(a, b) >= 0 ? a : b;
}

/** True for the `sha256:<hex>` spelling: `normalizeObservedKey` is the identity
 *  on a digest and maps an SPKI to something else, so no second regex is needed
 *  and the two modules cannot drift. */
function isKeyDigest(publicKey: string): boolean {
	return normalizeObservedKey(publicKey) === publicKey;
}

/**
 * A new window is emittable only when it does not overlap the last emitted one:
 * `window.from` at or after `lastEmittedWindowTo`. A record from before this
 * field existed, or one restored without it, emits once and then settles.
 */
function isNewWindow(record: KeyObservationRecord, window: AttestationWindow): boolean {
	const lastEmitted = record.lastEmittedWindowTo;
	if (lastEmitted === undefined || !isRfc3339(lastEmitted)) return true;
	return compareRfc3339(lastEmitted, window.from) <= 0;
}

/**
 * Turns a stream of verified signatures into the smallest set of
 * `key-observation` attestations that keeps challenge-time verification
 * possible.
 */
export class KeyObservationTracker {
	readonly #store: KeyObservationStore;

	constructor(store: KeyObservationStore) {
		this.#store = store;
	}

	/**
	 * Record one verification and, when it is news, draft the attestation.
	 *
	 * News is: a key never seen before (`first-observation`), a key seen before
	 * whose window has turned over (`window-update`, carrying the refreshed
	 * `lastSeen`), or a digest-only record that has just learned its SPKI
	 * (`public-key-upgraded`). Everything else updates the record silently.
	 *
	 * `dnssecValidated` is sticky: the body claims the chain validated at some
	 * point within [firstSeen, lastSeen], which is the property that matters at
	 * challenge time. A zone that stops signing does not retract the fact that
	 * this key was once served under a validated chain.
	 *
	 * The selector is folded to lowercase: DNS labels are case-insensitive, so
	 * `s=Sel1` and `s=sel1` name one `<selector>._domainkey.<domain>` record, and
	 * keeping them apart would split one key's corroboration in two.
	 */
	observe(input: KeyObservationInput, window: AttestationWindow): KeyObservationResult {
		const domain = normalizeDomain(input.domain);
		if (domain === undefined) return { ok: false, reason: 'invalid-domain' };
		if (!isDkimSelector(input.selector)) return { ok: false, reason: 'invalid-selector' };
		const selector = input.selector.toLowerCase();
		const keyId = normalizeObservedKey(input.publicKey);
		if (keyId === null) return { ok: false, reason: 'unusable-public-key' };
		if (!isRfc3339(input.seenAt)) return { ok: false, reason: 'invalid-seen-at' };
		if (
			!isRfc3339(window?.from) ||
			!isRfc3339(window.to) ||
			!isChronological(window.from, window.to)
		) {
			return { ok: false, reason: 'invalid-window' };
		}

		const existing = this.#store.get(domain, selector, keyId) ?? null;
		if (existing === null) {
			const record: KeyObservationRecord = {
				domain,
				selector,
				keyId,
				publicKey: input.publicKey,
				firstSeen: input.seenAt,
				lastSeen: input.seenAt,
				dnssecValidated: input.dnssecValidated === true,
				lastEmittedWindowTo: window.to,
			};
			this.#store.put(record);
			return {
				ok: true,
				record,
				draft: draftFor(record, window),
				disposition: 'first-observation',
			};
		}

		// A digest that has learned its SPKI is upgraded in place: the keyId is
		// unchanged (both spellings normalize to it), so this is the same record,
		// finally carrying a key a monitor can verify a signature with.
		const upgraded = isKeyDigest(existing.publicKey) && !isKeyDigest(input.publicKey);
		const record: KeyObservationRecord = {
			...existing,
			publicKey: upgraded ? input.publicKey : existing.publicKey,
			firstSeen: earliest(existing.firstSeen, input.seenAt),
			lastSeen: latest(existing.lastSeen, input.seenAt),
			dnssecValidated: existing.dnssecValidated || input.dnssecValidated === true,
		};
		const newWindow = isNewWindow(existing, window);
		const disposition: KeyObservationDisposition = newWindow
			? 'window-update'
			: upgraded
				? 'public-key-upgraded'
				: 'already-emitted-this-window';
		const emit = newWindow || upgraded;
		if (emit) {
			// Never let an out-of-order window move the rate limit backwards: that
			// would reopen emission for windows already published.
			const last = existing.lastEmittedWindowTo;
			record.lastEmittedWindowTo =
				last !== undefined && isRfc3339(last) ? latest(last, window.to) : window.to;
		}
		this.#store.put(record);
		return { ok: true, record, draft: emit ? draftFor(record, window) : null, disposition };
	}
}

function draftFor(
	record: KeyObservationRecord,
	window: AttestationWindow
): AttestationDraft<KeyObservationBody> {
	return {
		kind: 'key-observation',
		subject: { domain: record.domain },
		window,
		body: {
			domain: record.domain,
			selector: record.selector,
			publicKey: record.publicKey,
			firstSeen: record.firstSeen,
			lastSeen: record.lastSeen,
			dnssecValidated: record.dnssecValidated,
		},
	};
}

/** In-memory {@link KeyObservationStore} — the default for tests and for an app
 *  that rehydrates its key table at startup. */
export class MemoryKeyObservationStore implements KeyObservationStore {
	readonly #records = new Map<string, KeyObservationRecord>();

	static #key(domain: string, selector: string, keyId: string): string {
		return `${domain}\0${selector}\0${keyId}`;
	}

	get(domain: string, selector: string, keyId: string): KeyObservationRecord | null {
		return this.#records.get(MemoryKeyObservationStore.#key(domain, selector, keyId)) ?? null;
	}

	put(record: KeyObservationRecord): void {
		this.#records.set(
			MemoryKeyObservationStore.#key(record.domain, record.selector, record.keyId),
			record
		);
	}

	get size(): number {
		return this.#records.size;
	}

	values(): KeyObservationRecord[] {
		return [...this.#records.values()];
	}
}
