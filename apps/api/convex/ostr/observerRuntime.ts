'use node';

/**
 * The Node-runtime half of observer mode: the adapters that sit between
 * `@owlat/ostr-observer` (pure, injected, storage-free) and this deployment.
 *
 * The package supplies no clock, no `fetch`, no storage and no salt on purpose,
 * so exactly those four things live here — and nothing else does. No
 * admissibility rule, no k-threshold, no signing: those are the package's, and
 * a copy in Convex would be a second opinion that can disagree with the one the
 * log actually enforces.
 *
 * `'use node'` because everything under `@owlat/ostr-core` is `node:crypto`.
 * This module exports helpers rather than Convex functions (the same shape as
 * `e2ee/sealing.ts`); the two action modules that import it are its only
 * callers.
 */

import { createHmac } from 'node:crypto';
import { normalizeObservedKey, type Attestation, type AttestationWindow } from '@owlat/ostr-core';
import type {
	BatchCommitmentRecord,
	BatchCommitmentStore,
	DkimVerificationVerdict,
	KeyObservationRecord,
	KeyObservationStore,
	ObserverIdentity,
	PostJson,
	ReportDedupeStore,
} from '@owlat/ostr-observer';
import { getOptional } from '../lib/env';
import type { ObserverConfig } from './config';
import type { StoredKeyObservation } from './observerState';

/** RFC 3339 UTC, the only timestamp spelling the attestation format accepts. */
export function toRfc3339(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * The per-instance salt behind every opaque token this observer publishes a
 * COUNT of: reporter tokens and recipient tokens.
 *
 * `INSTANCE_SECRET` rather than a new variable, because a second secret is a
 * second thing to rotate, back up and lose — and losing this one only costs a
 * discontinuity in distinct-token counts, never correctness of anything
 * published. Absent ⇒ the capture path refuses rather than falling back to an
 * unsalted hash: an unsalted token is a mailbox id anyone with the id can
 * confirm, which is precisely what §7.4 forbids leaving anywhere near a
 * publication path.
 */
export function readTokenSalt(): string | undefined {
	const secret = getOptional('INSTANCE_SECRET');
	return secret === undefined || secret === '' ? undefined : secret;
}

/**
 * An opaque, per-instance-stable token for one mailbox.
 *
 * Domain-separated by `purpose` so the token a recipient count is derived from
 * and the token a reporter count is derived from cannot be correlated by
 * anyone who obtains one of them — a reporter is always also a recipient, and
 * matching the two lists would name them.
 */
export function mailboxToken(salt: string, purpose: 'reporter' | 'recipient', id: string): string {
	return createHmac('sha256', salt).update(`ostr:${purpose}:${id}`).digest('hex');
}

/** The registry identity this deployment signs as. Caller has already checked
 *  `canPublish`, so both halves are present. */
export function observerIdentity(
	config: ObserverConfig & { domain: string; privateKeyBase64: string }
): ObserverIdentity {
	return { domain: config.domain, privateKeyBase64: config.privateKeyBase64 };
}

/** The five verdicts `buildEvidenceBundle` knows. The wire contract carries a
 *  bare string, so it is narrowed here rather than guessed at the boundary. */
const DKIM_VERDICTS: readonly string[] = ['pass', 'fail', 'neutral', 'temperror', 'permerror'];

export function narrowDkimVerdict(value: string): DkimVerificationVerdict {
	// Anything unrecognised is deliberately mapped to `permerror` rather than
	// dropped: `buildEvidenceBundle` refuses everything but `pass`, so an
	// unknown verdict must reach it as a non-pass, not as a missing field.
	return DKIM_VERDICTS.includes(value) ? (value as DkimVerificationVerdict) : 'permerror';
}

/**
 * The `p=` tag of a DKIM key record — the base64 SPKI DER §7.5 wants logged.
 *
 * A five-line tag-list read, not a DKIM implementation: the record was already
 * parsed and used by the verifier that produced this evidence, and all that is
 * wanted here is the one field. An empty `p=` (DKIM's "this key is revoked"
 * convention) and a value `@owlat/ostr-core` will not accept both return
 * `undefined`, so the key simply is not logged.
 */
export function extractDkimPublicKey(dnsKeyRecordTxt: string): string | undefined {
	for (const segment of dnsKeyRecordTxt.split(';')) {
		const separator = segment.indexOf('=');
		if (separator < 0) continue;
		if (segment.slice(0, separator).trim().toLowerCase() !== 'p') continue;
		// A long key wraps across quoted TXT chunks; the whitespace is not part
		// of the base64.
		const value = segment.slice(separator + 1).replace(/\s+/g, '');
		return value !== '' && normalizeObservedKey(value) !== null ? value : undefined;
	}
	return undefined;
}

/**
 * `ReportDedupeStore` over `ostrReportQueue`.
 *
 * The package's interface is synchronous because it sits on a hot path; a
 * Convex action cannot be. So the known key is read once before the call and
 * the writes are collected for the caller to commit — and the commit mutation
 * re-checks the key in its own transaction, which is where the real race is
 * closed. This class is the shape adapter, not the concurrency control.
 */
export class QueuedReportDedupeStore implements ReportDedupeStore {
	readonly #known: ReadonlySet<string>;
	readonly writes = new Map<string, string>();

	constructor(known: Iterable<string>) {
		this.#known = new Set(known);
	}

	has(key: string): boolean {
		return this.#known.has(key) || this.writes.has(key);
	}

	add(key: string, capturedAt: string): void {
		this.writes.set(key, capturedAt);
	}
}

/**
 * `KeyObservationStore` over `ostrKeyObservations`, loaded whole for one window
 * pass and written back at the end. `touched` is the write set, so a pass that
 * saw no new keys writes nothing.
 */
export class LoadedKeyObservationStore implements KeyObservationStore {
	readonly #records = new Map<string, KeyObservationRecord>();
	readonly #touched = new Set<string>();

	constructor(rows: readonly StoredKeyObservation[]) {
		for (const row of rows) {
			this.#records.set(LoadedKeyObservationStore.#key(row.domain, row.selector, row.keyId), {
				domain: row.domain,
				selector: row.selector,
				keyId: row.keyId,
				publicKey: row.publicKey,
				firstSeen: row.firstSeen,
				lastSeen: row.lastSeen,
				dnssecValidated: row.isDnssecValidated,
				lastEmittedWindowTo: row.lastEmittedWindowTo,
			});
		}
	}

	static #key(domain: string, selector: string, keyId: string): string {
		return `${domain}\0${selector}\0${keyId}`;
	}

	get(domain: string, selector: string, keyId: string): KeyObservationRecord | null {
		return this.#records.get(LoadedKeyObservationStore.#key(domain, selector, keyId)) ?? null;
	}

	put(record: KeyObservationRecord): void {
		const key = LoadedKeyObservationStore.#key(record.domain, record.selector, record.keyId);
		this.#records.set(key, record);
		this.#touched.add(key);
	}

	/** The records this pass changed, in the table's spelling. */
	touched(): StoredKeyObservation[] {
		const out: StoredKeyObservation[] = [];
		for (const key of this.#touched) {
			const record = this.#records.get(key);
			if (record === undefined) continue;
			out.push({
				domain: record.domain,
				selector: record.selector,
				keyId: record.keyId,
				publicKey: record.publicKey,
				firstSeen: record.firstSeen,
				lastSeen: record.lastSeen,
				isDnssecValidated: record.dnssecValidated,
				lastEmittedWindowTo: record.lastEmittedWindowTo,
			});
		}
		return out;
	}
}

/**
 * `BatchCommitmentStore` as a WRITE-THROUGH buffer (§7.2.4).
 *
 * `retainBatchCommitment` is the package's guard that a batch draft carries the
 * window its record is filed under; it needs a store to put the record in, and
 * ours is a Convex table one mutation away. So `get` answers nothing — this
 * pass is publishing, not opening — and `put` collects, exactly the shape the
 * package's own docs describe for an app with a durable async store.
 */
export class CollectedBatchCommitmentStore implements BatchCommitmentStore {
	readonly #records: BatchCommitmentRecord[] = [];

	get(): null {
		return null;
	}

	put(record: BatchCommitmentRecord): void {
		this.#records.push(record);
	}

	/** The records this pass produced, in publication order. */
	records(): readonly BatchCommitmentRecord[] {
		return this.#records;
	}
}

/** How long one log submission may take before the pass moves on. A log that
 *  is slow is a log the next window retries; a log that hangs must not be able
 *  to stall an hour's publication. */
const SUBMIT_TIMEOUT_MS = 10_000;

/**
 * The package's injected HTTP poster.
 *
 * REJECTS on any non-2xx, because `submitAll` reports "accepted" for whatever
 * this resolves with — a poster that resolves on a 4xx makes the ledger claim
 * an acceptance that never happened, and the whole point of the cross-log
 * ledger is that it is honest about what reached where.
 */
export const postJson: PostJson = async (url, body) => {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${response.status} ${clampError(text)}`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { status: response.status };
	}
};

/** Bound a log's error text before it lands in the ledger or a log line. */
export function clampError(value: unknown): string {
	const text =
		value instanceof Error
			? value.message
			: typeof value === 'string'
				? value
				: 'submission failed';
	// Control characters out of a remote server's error body must not reach a log
	// line verbatim, and 200 characters is as much of a rejection as anyone reads.
	// `\p{Cc}` rather than a literal control-character range: the class is the
	// same, and the escape keeps the control bytes out of this file too.
	return text
		.replace(/\p{Cc}+/gu, ' ')
		.trim()
		.slice(0, 200);
}

/** The subject as the ledger displays it. Public information by construction —
 *  it is in the signed body too. */
export function describeSubject(attestation: Attestation): string {
	return attestation.subject.domain ?? attestation.subject.ip ?? '';
}

/** Half-open window bounds, as the package's builders take them. */
export function windowOf(fromMs: number, toMs: number): AttestationWindow {
	return { from: toRfc3339(fromMs), to: toRfc3339(toMs) };
}
