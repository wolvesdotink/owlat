/**
 * Inclusion promises (plan §9.1): the signed commitment a log hands back on
 * submission, before any STH covers the entry.
 */

import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '../../crypto.js';
import { canonicalize } from '../../jcs.js';
import { leafHash } from '../hash.js';
import { toHex } from '../hex.js';
import {
	inclusionDeadline,
	INCLUSION_PROMISE_TYPE,
	inclusionPromiseCoversLeaf,
	inclusionPromiseSigningBytes,
	signInclusionPromise,
	verifyInclusionPromise,
	type SignedInclusionPromise,
	type UnsignedInclusionPromise,
} from '../promise.js';

const keys = generateEd25519KeyPair();
const otherKeys = generateEd25519KeyPair();

const leaf = Buffer.from('ostr-attestation-leaf', 'utf8');
const promise: UnsignedInclusionPromise = {
	logId: 'log.ostr.example',
	leafHash: toHex(leafHash(leaf)),
	timestamp: '2026-08-20T10:30:00Z',
	mmdSeconds: 86_400,
};

/** Pinned vector produced outside this package, as for the STH. */
const VECTOR = {
	privateKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
	publicKey: '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=',
	leafHash: '3b2aa6f5135018e9ac2a2359956dc66897d58926c53b669042bf1900b1022202',
	signingInput:
		'{"leafHash":"3b2aa6f5135018e9ac2a2359956dc66897d58926c53b669042bf1900b1022202","logId":"log.ostr.example","mmdSeconds":86400,"timestamp":"2026-08-20T10:30:00Z","type":"inclusion-promise","v":1}',
	sig: 'ed25519:tyzHtI2CaWqFebybDpknB5SiHISfqfMVOREr6XhHra/1/IvxZqD6phtimlO8ajNoyCM2TV+fpIBsy6Al8aN6Ag==',
};

describe('inclusion promise known-answer vector', () => {
	it('signs the pinned bytes with the pinned signature', () => {
		expect(promise.leafHash).toBe(VECTOR.leafHash);
		expect(inclusionPromiseSigningBytes(promise).toString('utf8')).toBe(VECTOR.signingInput);
		expect(signInclusionPromise(promise, VECTOR.privateKey).sig).toBe(VECTOR.sig);
	});

	it('verifies the pinned promise document', () => {
		const signed: SignedInclusionPromise = {
			v: 1,
			type: 'inclusion-promise',
			...promise,
			sig: VECTOR.sig,
		};
		expect(verifyInclusionPromise(signed, VECTOR.publicKey)).toBe(true);
	});
});

describe('signInclusionPromise / verifyInclusionPromise', () => {
	it('round-trips and carries the version and type tag', () => {
		const signed = signInclusionPromise(promise, keys.privateKey);
		expect(signed.v).toBe(1);
		expect(signed.type).toBe(INCLUSION_PROMISE_TYPE);
		expect(verifyInclusionPromise(signed, keys.publicKey)).toBe(true);
		expect(verifyInclusionPromise(signed, otherKeys.publicKey)).toBe(false);
	});

	it('signs the canonical form of the facts plus the version and type', () => {
		expect(inclusionPromiseSigningBytes(promise).toString('utf8')).toBe(
			canonicalize({
				leafHash: promise.leafHash,
				logId: promise.logId,
				mmdSeconds: promise.mmdSeconds,
				timestamp: promise.timestamp,
				type: 'inclusion-promise',
				v: 1,
			})
		);
	});

	it('is not interchangeable with a tree-head signature', () => {
		// Same key, same log, same instant: the type tag keeps the two apart.
		const signed = signInclusionPromise(promise, keys.privateKey);
		expect(
			verifyInclusionPromise({ ...signed, type: 'sth' } as SignedInclusionPromise, keys.publicKey)
		).toBe(false);
		expect(
			verifyInclusionPromise(
				{ ...signed, v: 2 } as unknown as SignedInclusionPromise,
				keys.publicKey
			)
		).toBe(false);
	});

	it.each([
		['leafHash', { leafHash: toHex(leafHash(Buffer.from('other', 'utf8'))) }],
		['logId', { logId: 'evil.ostr.example' }],
		['timestamp', { timestamp: '2026-08-20T10:30:01Z' }],
		['mmdSeconds', { mmdSeconds: 604_800 }],
	])('rejects a tampered %s', (_field, patch) => {
		const signed = signInclusionPromise(promise, keys.privateKey);
		expect(verifyInclusionPromise({ ...signed, ...patch }, keys.publicKey)).toBe(false);
	});

	it('rejects a non-canonical signature encoding', () => {
		const signed = signInclusionPromise(promise, keys.privateKey);
		const raw = signed.sig.slice('ed25519:'.length);
		expect(
			verifyInclusionPromise(
				{ ...signed, sig: `ed25519:${raw.replace(/=+$/, '')}` },
				keys.publicKey
			)
		).toBe(false);
		expect(verifyInclusionPromise({ ...signed, sig: raw }, keys.publicKey)).toBe(false);
	});

	it.each([
		['empty logId', { logId: '' }],
		['uppercase leaf hash', { leafHash: VECTOR.leafHash.toUpperCase() }],
		['non-hex leaf hash', { leafHash: 'z'.repeat(64) }],
		['zero MMD', { mmdSeconds: 0 }],
		['negative MMD', { mmdSeconds: -1 }],
		['fractional MMD', { mmdSeconds: 1.5 }],
		['offset timestamp', { timestamp: '2026-08-20T12:30:00+02:00' }],
		['impossible date', { timestamp: '2026-02-30T10:00:00Z' }],
	])('refuses to sign a malformed promise: %s', (_case, patch) => {
		expect(() => signInclusionPromise({ ...promise, ...patch }, keys.privateKey)).toThrow(
			RangeError
		);
		expect(() => inclusionPromiseSigningBytes({ ...promise, ...patch })).toThrow(RangeError);
	});

	it('fails verification of a malformed promise rather than throwing', () => {
		const signed = signInclusionPromise(promise, keys.privateKey);
		expect(verifyInclusionPromise({ ...signed, leafHash: 'nope' }, keys.publicKey)).toBe(false);
		expect(verifyInclusionPromise(signed, 'not-a-key')).toBe(false);
		expect(
			verifyInclusionPromise(undefined as unknown as SignedInclusionPromise, keys.publicKey)
		).toBe(false);
	});
});

describe('promise bindings', () => {
	it('covers exactly the submitted leaf bytes', () => {
		expect(inclusionPromiseCoversLeaf(promise, leaf)).toBe(true);
		expect(inclusionPromiseCoversLeaf(promise, Buffer.concat([leaf, Buffer.from('!')]))).toBe(
			false
		);
		// A leaf hash presented as leaf data does not open the promise either.
		expect(inclusionPromiseCoversLeaf(promise, leafHash(leaf))).toBe(false);
		expect(inclusionPromiseCoversLeaf({ ...promise, leafHash: 'nope' }, leaf)).toBe(false);
	});

	it('derives the merge deadline from the promise, not from a clock', () => {
		const deadline = inclusionDeadline(promise);
		expect(deadline).toBe(Date.parse('2026-08-21T10:30:00Z'));
		expect(inclusionDeadline({ ...promise, mmdSeconds: 3_600 })).toBe(
			Date.parse('2026-08-20T11:30:00Z')
		);
		expect(inclusionDeadline({ ...promise, timestamp: 'yesterday' })).toBeUndefined();
	});
});
