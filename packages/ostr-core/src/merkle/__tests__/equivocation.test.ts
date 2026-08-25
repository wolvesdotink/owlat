/**
 * The §9.1 gossip check: two heads of one log, one verdict. A split view and a
 * broken extension are findings; anything a monitor has not proven yet is not.
 */

import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '../../crypto.js';
import { detectEquivocation, isEquivocationProven } from '../equivocation.js';
import { signTreeHead, type SignedTreeHead, type UnsignedTreeHead } from '../sth.js';
import { MerkleTree } from '../tree.js';

const keys = generateEd25519KeyPair();
const otherKeys = generateEd25519KeyPair();

const leafFor = (i: number): Buffer => Buffer.from(`ostr-entry-${i}`, 'utf8');
const honest = MerkleTree.from(Array.from({ length: 32 }, (_, i) => leafFor(i)));
/** A second history the log could show a different audience. */
const forked = MerkleTree.from(
	Array.from({ length: 32 }, (_, i) => (i === 9 ? Buffer.from('rewritten', 'utf8') : leafFor(i)))
);

const headAt = (tree: MerkleTree, size: number, minute = 0): SignedTreeHead =>
	signTreeHead(
		{
			logId: 'log.ostr.example',
			treeSize: size,
			rootHash: tree.root(size).toString('hex'),
			timestamp: `2026-08-20T10:${String(minute).padStart(2, '0')}:00Z`,
		} satisfies UnsignedTreeHead,
		keys.privateKey
	);

describe('detectEquivocation', () => {
	it('accepts a log that only grew, given its consistency proof', () => {
		expect(
			detectEquivocation({
				a: headAt(honest, 5),
				b: headAt(honest, 21, 30),
				publicKeyBase64: keys.publicKey,
				consistencyProof: honest.consistencyProof(5, 21),
			})
		).toBe('consistent');
	});

	it('does not care which head is passed first', () => {
		const older = headAt(honest, 5);
		const newer = headAt(honest, 21, 30);
		const proof = honest.consistencyProof(5, 21);
		const input = { publicKeyBase64: keys.publicKey, consistencyProof: proof };
		expect(detectEquivocation({ a: older, b: newer, ...input })).toBe('consistent');
		expect(detectEquivocation({ a: newer, b: older, ...input })).toBe('consistent');
	});

	it('accepts two heads of the same size and root as one history', () => {
		expect(
			detectEquivocation({
				a: headAt(honest, 12),
				b: headAt(honest, 12, 45),
				publicKeyBase64: keys.publicKey,
			})
		).toBe('consistent');
	});

	it('calls the same size with two roots a split view', () => {
		const verdict = detectEquivocation({
			a: headAt(honest, 12),
			b: headAt(forked, 12, 45),
			publicKeyBase64: keys.publicKey,
		});
		expect(verdict).toBe('split-view');
		expect(isEquivocationProven(verdict)).toBe(true);
	});

	it('calls a failing consistency proof an inconsistent extension', () => {
		const verdict = detectEquivocation({
			a: headAt(honest, 5),
			b: headAt(forked, 21, 30),
			publicKeyBase64: keys.publicKey,
			// The log serves the proof for the history it published first.
			consistencyProof: honest.consistencyProof(5, 21),
		});
		expect(verdict).toBe('inconsistent-extension');
		expect(isEquivocationProven(verdict)).toBe(true);
	});

	it('reports differing sizes without a proof as unproven, not as a finding', () => {
		const verdict = detectEquivocation({
			a: headAt(honest, 5),
			b: headAt(forked, 21, 30),
			publicKeyBase64: keys.publicKey,
		});
		expect(verdict).toBe('unproven');
		expect(isEquivocationProven(verdict)).toBe(false);
	});

	it('treats an unsigned or foreign-key head as no evidence at all', () => {
		const good = headAt(honest, 12);
		const tampered: SignedTreeHead = { ...headAt(forked, 12, 45), sig: good.sig };
		const verdict = detectEquivocation({
			a: good,
			b: tampered,
			publicKeyBase64: keys.publicKey,
		});
		expect(verdict).toBe('unsigned');
		expect(isEquivocationProven(verdict)).toBe(false);
		expect(
			detectEquivocation({
				a: good,
				b: headAt(forked, 12, 45),
				publicKeyBase64: otherKeys.publicKey,
			})
		).toBe('unsigned');
	});

	it('refuses to compare heads of two different logs', () => {
		const mirror = signTreeHead(
			{
				logId: 'mirror.ostr.example',
				treeSize: 12,
				rootHash: forked.root(12).toString('hex'),
				timestamp: '2026-08-20T10:45:00Z',
			},
			keys.privateKey
		);
		expect(
			detectEquivocation({ a: headAt(honest, 12), b: mirror, publicKeyBase64: keys.publicKey })
		).toBe('not-comparable');
	});

	it('rejects a padded or truncated consistency proof', () => {
		const proof = honest.consistencyProof(5, 21);
		for (const broken of [proof.slice(1), [...proof, honest.root(3)], []]) {
			expect(
				detectEquivocation({
					a: headAt(honest, 5),
					b: headAt(honest, 21, 30),
					publicKeyBase64: keys.publicKey,
					consistencyProof: broken,
				})
			).toBe('inconsistent-extension');
		}
	});
});
