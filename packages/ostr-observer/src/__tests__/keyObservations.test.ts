import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
	generateEd25519KeyPair,
	normalizeObservedKey,
	validateAttestation,
} from '@owlat/ostr-core';
import {
	KeyObservationTracker,
	MemoryKeyObservationStore,
	type KeyObservationInput,
} from '../keyObservations.js';
import { signDrafts } from '../sign.js';

const WINDOW = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };
const NEXT_WINDOW = { from: '2026-08-20T00:00:00Z', to: '2026-08-21T00:00:00Z' };

/** A real RSA SPKI, base64 — what a DKIM TXT record's `p=` carries. */
function spkiDer(): string {
	const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

const KEY_A = spkiDer();
const KEY_B = spkiDer();

function input(overrides: Partial<KeyObservationInput> = {}): KeyObservationInput {
	return {
		domain: 'example.com',
		selector: 'sel1',
		publicKey: KEY_A,
		dnssecValidated: true,
		seenAt: '2026-08-19T09:00:00Z',
		...overrides,
	};
}

describe('KeyObservationTracker (§7.5)', () => {
	it('emits on the first verification with a key', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		const result = tracker.observe(input(), WINDOW);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.disposition).toBe('first-observation');
		expect(result.draft).not.toBeNull();
		expect(result.draft?.kind).toBe('key-observation');
		expect(result.draft?.subject).toEqual({ domain: 'example.com' });
		expect(result.draft?.body).toEqual({
			domain: 'example.com',
			selector: 'sel1',
			// The SPKI itself, not its digest: a digest cannot re-verify a signature.
			publicKey: KEY_A,
			firstSeen: '2026-08-19T09:00:00Z',
			lastSeen: '2026-08-19T09:00:00Z',
			dnssecValidated: true,
		});
		expect(store.size).toBe(1);
	});

	it('stays silent for later verifications inside the same window', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		tracker.observe(input(), WINDOW);
		const second = tracker.observe(input({ seenAt: '2026-08-19T18:30:00Z' }), WINDOW);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.disposition).toBe('already-emitted-this-window');
		expect(second.draft).toBeNull();
		// lastSeen still advances — the record is what a challenge is adjudicated against.
		expect(second.record.lastSeen).toBe('2026-08-19T18:30:00Z');
		expect(second.record.firstSeen).toBe('2026-08-19T09:00:00Z');
	});

	it('emits at most one update per window, carrying the refreshed lastSeen', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		tracker.observe(input(), WINDOW);
		const update = tracker.observe(input({ seenAt: '2026-08-20T07:00:00Z' }), NEXT_WINDOW);
		expect(update.ok).toBe(true);
		if (!update.ok) return;
		expect(update.disposition).toBe('window-update');
		expect(update.draft?.body.lastSeen).toBe('2026-08-20T07:00:00Z');
		expect(update.draft?.body.firstSeen).toBe('2026-08-19T09:00:00Z');
		expect(update.draft?.window).toEqual(NEXT_WINDOW);

		const again = tracker.observe(input({ seenAt: '2026-08-20T08:00:00Z' }), NEXT_WINDOW);
		expect(again.ok && again.draft).toBeNull();
	});

	it('keeps an out-of-order observation from moving lastSeen backwards', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		tracker.observe(input({ seenAt: '2026-08-19T12:00:00Z' }), WINDOW);
		const late = tracker.observe(input({ seenAt: '2026-08-19T06:00:00Z' }), NEXT_WINDOW);
		expect(late.ok).toBe(true);
		if (!late.ok) return;
		expect(late.record.firstSeen).toBe('2026-08-19T06:00:00Z');
		expect(late.record.lastSeen).toBe('2026-08-19T12:00:00Z');
	});

	it('treats a rotation as a new key with its own first observation', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		tracker.observe(input(), WINDOW);
		const rotated = tracker.observe(input({ publicKey: KEY_B }), WINDOW);
		expect(rotated.ok).toBe(true);
		if (!rotated.ok) return;
		expect(rotated.disposition).toBe('first-observation');
		expect(store.size).toBe(2);

		const newSelector = tracker.observe(input({ selector: 'sel2' }), WINDOW);
		expect(newSelector.ok && newSelector.disposition).toBe('first-observation');
		expect(store.size).toBe(3);
	});

	it('identifies a key by its normalized digest, whichever spelling was seen', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		const first = tracker.observe(input(), WINDOW);
		const digest = normalizeObservedKey(KEY_A) as string;
		const second = tracker.observe(input({ publicKey: digest }), WINDOW);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.disposition).toBe('already-emitted-this-window');
		expect(second.record.keyId).toBe(digest);
		expect(store.size).toBe(1);
	});

	it('keeps dnssecValidated sticky once a validated chain has been seen', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		tracker.observe(input({ dnssecValidated: true }), WINDOW);
		const later = tracker.observe(input({ dnssecValidated: false }), NEXT_WINDOW);
		expect(later.ok && later.record.dnssecValidated).toBe(true);
	});

	it('upgrades an unvalidated record when the chain later validates', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		const first = tracker.observe(input({ dnssecValidated: false }), WINDOW);
		expect(first.ok && first.draft?.body.dnssecValidated).toBe(false);
		const later = tracker.observe(input({ dnssecValidated: true }), NEXT_WINDOW);
		expect(later.ok && later.draft?.body.dnssecValidated).toBe(true);
	});

	it('refuses input the log would reject', () => {
		const tracker = new KeyObservationTracker(new MemoryKeyObservationStore());
		expect(tracker.observe(input({ domain: 'localhost' }), WINDOW)).toEqual({
			ok: false,
			reason: 'invalid-domain',
		});
		expect(tracker.observe(input({ selector: 'sel 1' }), WINDOW)).toEqual({
			ok: false,
			reason: 'invalid-selector',
		});
		expect(tracker.observe(input({ publicKey: 'not-a-key' }), WINDOW)).toEqual({
			ok: false,
			reason: 'unusable-public-key',
		});
		expect(tracker.observe(input({ seenAt: 'now' }), WINDOW)).toEqual({
			ok: false,
			reason: 'invalid-seen-at',
		});
		expect(
			tracker.observe(input(), { from: '2026-08-20T00:00:00Z', to: '2026-08-19T00:00:00Z' })
		).toEqual({ ok: false, reason: 'invalid-window' });
	});

	it('drafts an attestation the core accepts as valid once signed', () => {
		const tracker = new KeyObservationTracker(new MemoryKeyObservationStore());
		const observed = tracker.observe(input(), WINDOW);
		expect(observed.ok).toBe(true);
		if (!observed.ok || observed.draft === null) return;
		const identity = {
			domain: 'mx.hinterland.camp',
			privateKeyBase64: generateEd25519KeyPair().privateKey,
		};
		const [signed] = signDrafts(identity, [observed.draft]);
		expect(validateAttestation(signed).ok).toBe(true);
		// The published key really is a parseable SPKI, years later.
		expect(() =>
			createPublicKey({
				key: Buffer.from(observed.draft?.body.publicKey ?? '', 'base64'),
				format: 'der',
				type: 'spki',
			})
		).not.toThrow();
	});
});

describe('the emission rate limit is per unit of time, not per window value', () => {
	it('drafts once for 500 messages under a rolling window', () => {
		const tracker = new KeyObservationTracker(new MemoryKeyObservationStore());
		let drafts = 0;
		for (let minute = 1; minute <= 500; minute++) {
			const at = new Date(Date.UTC(2026, 7, 19, 0, minute, 0)).toISOString().replace('.000', '');
			// The obvious wiring once a clock exists: a fresh `to` on every message.
			const result = tracker.observe(input({ seenAt: at }), { from: WINDOW.from, to: at });
			expect(result.ok).toBe(true);
			if (result.ok && result.draft !== null) drafts++;
		}
		expect(drafts).toBe(1);
	});

	it('drafts again only once the new window clears the last emitted one', () => {
		const tracker = new KeyObservationTracker(new MemoryKeyObservationStore());
		tracker.observe(input(), WINDOW);
		const overlapping = tracker.observe(input({ seenAt: '2026-08-19T23:00:00Z' }), {
			from: '2026-08-19T12:00:00Z',
			to: '2026-08-20T12:00:00Z',
		});
		expect(overlapping.ok && overlapping.disposition).toBe('already-emitted-this-window');
		expect(overlapping.ok && overlapping.draft).toBeNull();

		const disjoint = tracker.observe(input({ seenAt: '2026-08-20T09:00:00Z' }), NEXT_WINDOW);
		expect(disjoint.ok && disjoint.disposition).toBe('window-update');
	});
});

describe('the published key upgrades from a digest to the SPKI', () => {
	it('replaces a digest-only record when the DER finally arrives', () => {
		const tracker = new KeyObservationTracker(new MemoryKeyObservationStore());
		const digest = normalizeObservedKey(KEY_A) as string;
		const first = tracker.observe(input({ publicKey: digest }), WINDOW);
		expect(first.ok && first.draft?.body.publicKey).toBe(digest);

		// Same window, so the rate limit alone would say nothing — but a digest
		// cannot re-verify a signature, which is what §7.5 exists for.
		const upgraded = tracker.observe(input({ publicKey: KEY_A }), WINDOW);
		expect(upgraded.ok).toBe(true);
		if (!upgraded.ok) return;
		expect(upgraded.disposition).toBe('public-key-upgraded');
		expect(upgraded.record.publicKey).toBe(KEY_A);
		expect(upgraded.draft?.body.publicKey).toBe(KEY_A);
		expect(upgraded.record.keyId).toBe(digest);

		// And it does not thrash: once upgraded, the digest spelling is ignored.
		const back = tracker.observe(input({ publicKey: digest }), WINDOW);
		expect(back.ok && back.disposition).toBe('already-emitted-this-window');
		expect(back.ok && back.record.publicKey).toBe(KEY_A);
	});
});

describe('the selector is a DNS label, so its case does not matter', () => {
	it('folds selector case into one record and one draft', () => {
		const store = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(store);
		const first = tracker.observe(input({ selector: 'Sel1' }), WINDOW);
		const second = tracker.observe(input({ selector: 'sel1' }), WINDOW);
		expect(first.ok && first.draft?.body.selector).toBe('sel1');
		expect(second.ok && second.disposition).toBe('already-emitted-this-window');
		expect(second.ok && second.draft).toBeNull();
		expect(store.size).toBe(1);
	});
});
