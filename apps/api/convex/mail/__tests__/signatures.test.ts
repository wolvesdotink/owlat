/**
 * Pure-helper coverage for signature detection from imported sent mail
 * (mail/signatures.ts): candidate extraction from one body and the
 * repeated-block detection across a sample of bodies.
 */
import { describe, it, expect } from 'vitest';
import { detectSignatureFromBodies, extractSignatureCandidate } from '../signatures';

const SIG = 'Jane Doe\nHead of Product, Acme\n+1 555 0100';

describe('extractSignatureCandidate', () => {
	it('prefers the RFC 3676 "-- " delimiter', () => {
		const body = `Thanks, talk soon.\n\n-- \n${SIG}`;
		expect(extractSignatureCandidate(body)).toBe(SIG);
	});

	it('strips quoted reply content before the signature', () => {
		const body = `Sounds good.\n\n-- \n${SIG}\n\nOn Mon, Jan 1, Bob wrote:\n> earlier message\n> more quote`;
		expect(extractSignatureCandidate(body)).toBe(SIG);
	});

	it('falls back to the last block of non-empty lines when there is no delimiter', () => {
		const body = `Here is the update you asked for.\n\n${SIG}`;
		expect(extractSignatureCandidate(body)).toBe(SIG);
	});

	it('returns null for an empty body', () => {
		expect(extractSignatureCandidate('   \n\n')).toBeNull();
	});

	it('rejects an over-tall block', () => {
		const tall = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
		expect(extractSignatureCandidate(`Body\n\n${tall}`)).toBeNull();
	});
});

describe('detectSignatureFromBodies', () => {
	it('returns the block that repeats across at least two messages', () => {
		const bodies = [
			`First note.\n\n-- \n${SIG}`,
			`Second note, different opening.\n\n-- \n${SIG}`,
			`One-off closing line that never repeats`,
		];
		expect(detectSignatureFromBodies(bodies)).toBe(SIG);
	});

	it('returns null when nothing repeats', () => {
		const bodies = [`Note one\n\n-- \nAlice`, `Note two\n\n-- \nBob`];
		expect(detectSignatureFromBodies(bodies)).toBeNull();
	});

	it('returns null for an empty sample', () => {
		expect(detectSignatureFromBodies([])).toBeNull();
	});
});
