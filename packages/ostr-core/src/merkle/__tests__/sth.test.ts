/**
 * Signed tree heads: the pinned wire vector, round-trip, canonical signing
 * input, and every tamper that would let a log rewrite what it already
 * published.
 */

import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '../../crypto.js';
import { canonicalize } from '../../jcs.js';
import { MerkleTree } from '../tree.js';
import {
	signTreeHead,
	STH_SIGNATURE_TYPE,
	treeHeadSigningBytes,
	verifyTreeHead,
	type SignedTreeHead,
	type UnsignedTreeHead,
} from '../sth.js';

const keys = generateEd25519KeyPair();
const otherKeys = generateEd25519KeyPair();

const tree = MerkleTree.from(
	Array.from({ length: 12 }, (_, i) => Buffer.from(`ostr-entry-${i}`, 'utf8'))
);

const head: UnsignedTreeHead = {
	logId: 'log.ostr.example',
	treeSize: tree.size,
	rootHash: tree.root().toString('hex'),
	timestamp: '2026-08-20T10:30:00Z',
};

/**
 * Pinned vector, produced outside this package: a fixed ed25519 seed over the
 * head of the RFC 6962 eight-leaf reference tree. The signing input and the
 * signature are literals, so a change in the JCS serializer, the field set or
 * the version/type tags fails here instead of silently invalidating every STH
 * this log ever issued.
 */
const VECTOR = {
	privateKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
	publicKey: '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=',
	head: {
		logId: 'log.ostr.example',
		treeSize: 8,
		rootHash: '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
		timestamp: '2026-08-20T10:30:00Z',
	} satisfies UnsignedTreeHead,
	signingInput:
		'{"logId":"log.ostr.example","rootHash":"5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328","timestamp":"2026-08-20T10:30:00Z","treeSize":8,"type":"sth","v":1}',
	sig: 'ed25519:qnkQZk4rNjnb5wvqOKep8PvyiYXIV3EShqHec9LRYM8NrOkJjUlX6zx5n393oOL7GLioK3cZFZf9Zb5Ys7vrAg==',
};

describe('STH known-answer vector', () => {
	it('signs the pinned bytes with the pinned signature', () => {
		expect(treeHeadSigningBytes(VECTOR.head).toString('utf8')).toBe(VECTOR.signingInput);
		const sth = signTreeHead(VECTOR.head, VECTOR.privateKey);
		expect(sth.sig).toBe(VECTOR.sig);
		expect(sth.v).toBe(1);
		expect(sth.type).toBe(STH_SIGNATURE_TYPE);
	});

	it('verifies the pinned STH document', () => {
		const sth: SignedTreeHead = {
			v: 1,
			type: 'sth',
			...VECTOR.head,
			sig: VECTOR.sig,
		};
		expect(verifyTreeHead(sth, VECTOR.publicKey)).toBe(true);
	});

	it('covers the head of the tree it names', () => {
		const rfc6962 = MerkleTree.from(
			[
				'',
				'00',
				'10',
				'2021',
				'3031',
				'40414243',
				'5051525354555657',
				'606162636465666768696a6b6c6d6e6f',
			].map((hex) => Buffer.from(hex, 'hex'))
		);
		expect(rfc6962.root().toString('hex')).toBe(VECTOR.head.rootHash);
	});
});

describe('signTreeHead / verifyTreeHead', () => {
	it('round-trips', () => {
		const sth = signTreeHead(head, keys.privateKey);
		expect(sth.sig.startsWith('ed25519:')).toBe(true);
		expect(verifyTreeHead(sth, keys.publicKey)).toBe(true);
	});

	it('is deterministic and clock-free — the same head signs identically', () => {
		expect(signTreeHead(head, keys.privateKey)).toEqual(signTreeHead(head, keys.privateKey));
	});

	it('signs the RFC 8785 canonical form of the facts plus the version and type', () => {
		expect(treeHeadSigningBytes(head).toString('utf8')).toBe(
			canonicalize({
				logId: head.logId,
				rootHash: head.rootHash,
				timestamp: head.timestamp,
				treeSize: head.treeSize,
				type: 'sth',
				v: 1,
			})
		);
		// Member order in the input must not change the signed bytes.
		const reordered: UnsignedTreeHead = {
			timestamp: head.timestamp,
			rootHash: head.rootHash,
			treeSize: head.treeSize,
			logId: head.logId,
		};
		expect(treeHeadSigningBytes(reordered)).toEqual(treeHeadSigningBytes(head));
	});

	it('rejects a foreign key', () => {
		expect(verifyTreeHead(signTreeHead(head, keys.privateKey), otherKeys.publicKey)).toBe(false);
	});

	it.each([
		[
			'rootHash',
			{
				rootHash: MerkleTree.from([Buffer.from('x')])
					.root()
					.toString('hex'),
			},
		],
		['treeSize', { treeSize: 13 }],
		['timestamp', { timestamp: '2026-08-20T10:30:01Z' }],
		['logId', { logId: 'evil.ostr.example' }],
		['version', { v: 2 }],
		['type tag', { type: 'inclusion-promise' }],
	])('rejects a tampered %s', (_field, patch) => {
		const sth = signTreeHead(head, keys.privateKey);
		expect(verifyTreeHead({ ...sth, ...patch } as SignedTreeHead, keys.publicKey)).toBe(false);
	});

	it('rejects a tampered or foreign-algorithm signature', () => {
		const sth = signTreeHead(head, keys.privateKey);
		const raw = sth.sig.slice('ed25519:'.length);
		const flipped = Buffer.from(raw, 'base64');
		flipped[0] = (flipped[0]! ^ 0x01) & 0xff;
		expect(
			verifyTreeHead({ ...sth, sig: `ed25519:${flipped.toString('base64')}` }, keys.publicKey)
		).toBe(false);
		expect(verifyTreeHead({ ...sth, sig: raw }, keys.publicKey)).toBe(false);
		expect(verifyTreeHead({ ...sth, sig: `ecdsa:${raw}` }, keys.publicKey)).toBe(false);
		expect(verifyTreeHead({ ...sth, sig: 'ed25519:' }, keys.publicKey)).toBe(false);
		expect(verifyTreeHead({ ...sth, sig: 'ed25519:not base64!!' }, keys.publicKey)).toBe(false);
	});

	it('accepts exactly one encoding of a signature, so gossip can dedup by bytes', () => {
		const sth = signTreeHead(head, keys.privateKey);
		const raw = sth.sig.slice('ed25519:'.length);
		const bytes = Buffer.from(raw, 'base64');
		expect(bytes).toHaveLength(64);
		for (const variant of [
			raw.replace(/=+$/, ''), // unpadded
			`${raw.slice(0, 20)}\n${raw.slice(20)}`, // whitespace injected
			bytes.toString('base64url'), // base64url alphabet
			`${raw}!!!`, // trailing garbage
			raw.slice(0, -4), // truncated to 63 bytes
			Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64'), // 65 bytes
		]) {
			expect(verifyTreeHead({ ...sth, sig: `ed25519:${variant}` }, keys.publicKey)).toBe(false);
		}
	});

	it('signs a head over the empty tree', () => {
		const empty: UnsignedTreeHead = {
			...head,
			treeSize: 0,
			rootHash: new MerkleTree().root().toString('hex'),
		};
		expect(verifyTreeHead(signTreeHead(empty, keys.privateKey), keys.publicKey)).toBe(true);
	});

	it.each([
		['empty logId', { logId: '' }],
		['uppercase root hash', { rootHash: head.rootHash.toUpperCase() }],
		['short root hash', { rootHash: 'abcd' }],
		['non-hex root hash', { rootHash: 'z'.repeat(64) }],
		['negative tree size', { treeSize: -1 }],
		['fractional tree size', { treeSize: 1.5 }],
		['date-only timestamp', { timestamp: '2026-08-20' }],
		['unzoned timestamp', { timestamp: '2026-08-20T10:30:00' }],
		['impossible month and day', { timestamp: '2026-19-99T99:99:99Z' }],
		['zeroed date', { timestamp: '0000-00-00T00:00:00Z' }],
		['day past the month end', { timestamp: '2026-02-30T10:00:00Z' }],
		['leap second', { timestamp: '2026-08-20T10:30:60Z' }],
		['out-of-range offset', { timestamp: '2026-08-20T10:30:00+99:99' }],
		['numeric offset instead of UTC', { timestamp: '2026-08-20T12:30:00+02:00' }],
		['lowercase designators', { timestamp: '2026-08-20t10:30:00z' }],
	])('refuses to sign a malformed head: %s', (_case, patch) => {
		expect(() => signTreeHead({ ...head, ...patch }, keys.privateKey)).toThrow(RangeError);
		// The signing-bytes escape hatch admits exactly the same heads.
		expect(() => treeHeadSigningBytes({ ...head, ...patch })).toThrow(RangeError);
	});

	it('accepts UTC instants with fractional seconds', () => {
		for (const timestamp of ['2026-08-20T10:30:00Z', '2026-08-20T10:30:00.123Z']) {
			const sth = signTreeHead({ ...head, timestamp }, keys.privateKey);
			expect(verifyTreeHead(sth, keys.publicKey)).toBe(true);
		}
	});

	it('fails verification of a malformed head rather than throwing', () => {
		const sth = signTreeHead(head, keys.privateKey);
		expect(verifyTreeHead({ ...sth, rootHash: 'nope' }, keys.publicKey)).toBe(false);
		expect(verifyTreeHead({ ...sth, timestamp: 'yesterday' }, keys.publicKey)).toBe(false);
		expect(verifyTreeHead(sth, 'not-a-key')).toBe(false);
		expect(
			verifyTreeHead({ ...sth, sig: undefined } as unknown as SignedTreeHead, keys.publicKey)
		).toBe(false);
		expect(verifyTreeHead(undefined as unknown as SignedTreeHead, keys.publicKey)).toBe(false);
	});
});
