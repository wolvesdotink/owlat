/**
 * Fuzz gate for `parseMessage` (piece P3).
 *
 * The facade must be TOTAL: hostile, truncated and randomly mutated input must
 * parse to a bounded {@link ParsedMessage} and NEVER throw (the MIME walker is
 * depth-capped and every decoder is total, so the facade inherits that). We run
 * 10k deterministic mutations seeded off the real corpus plus random byte soup,
 * asserting no throw and that the result stays within sane bounds.
 */

import { describe, it, expect } from 'vitest';
import { parseMessage } from '../parse/index';
import { RAW_FIXTURES } from './fixtures/rawCorpus';

/** A small deterministic xorshift PRNG so a failing seed is reproducible. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0 || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0xffffffff;
	};
}

/** Apply one random mutation (truncate / flip / inject / duplicate) to `input`. */
function mutate(input: string, rng: () => number): string {
	if (input.length === 0) return input;
	const kind = Math.floor(rng() * 5);
	const at = Math.floor(rng() * input.length);
	switch (kind) {
		case 0:
			// Truncate at a random offset.
			return input.slice(0, at);
		case 1:
			// Flip one byte to a random char (including control bytes).
			return (
				input.slice(0, at) + String.fromCharCode(Math.floor(rng() * 256)) + input.slice(at + 1)
			);
		case 2:
			// Inject a stray boundary / colon / angle bracket.
			return (
				input.slice(0, at) +
				['--B', ':', '<', '>', '\r\n', '='][Math.floor(rng() * 6)]! +
				input.slice(at)
			);
		case 3:
			// Duplicate a slice (grow multipart depth / header runs).
			return input.slice(0, at) + input.slice(at, at + 40) + input.slice(at);
		default:
			// Drop CRLFs to fuse headers into the body.
			return input.slice(0, at) + input.slice(at).replace(/\r\n/g, '');
	}
}

/** A pool of random byte soup so the fuzzer also sees non-corpus input. */
function randomSoup(rng: () => number): string {
	const len = Math.floor(rng() * 400);
	let out = '';
	for (let i = 0; i < len; i++) out += String.fromCharCode(Math.floor(rng() * 256));
	return out;
}

describe('parseMessage fuzz — 10k mutations never throw and stay bounded', () => {
	it('parses 10k mutated inputs without throwing', () => {
		const rng = makeRng(0x1234abcd);
		const seeds = RAW_FIXTURES.map((f) => f.raw);
		let parsed = 0;
		for (let i = 0; i < 10_000; i++) {
			const base = rng() < 0.85 ? seeds[i % seeds.length]! : randomSoup(rng);
			let input = base;
			const rounds = 1 + Math.floor(rng() * 4);
			for (let r = 0; r < rounds; r++) input = mutate(input, rng);

			let ok = false;
			try {
				const msg = parseMessage(input);
				// Bounded output: the header multimap and attachment list cannot
				// explode past sane ceilings for these short inputs.
				expect(msg.headers.size).toBeLessThan(10_000);
				expect(msg.attachments.length).toBeLessThan(5_000);
				// The html sentinel is always a string or the literal `false`.
				expect(msg.html === false || typeof msg.html === 'string').toBe(true);
				ok = true;
			} catch (err) {
				throw new Error(`parseMessage threw on mutation ${String(i)}: ${String(err)}`);
			}
			if (ok) parsed++;
		}
		expect(parsed).toBe(10_000);
	});

	it('parses a Buffer and an empty input without throwing', () => {
		expect(() => parseMessage(Buffer.from(RAW_FIXTURES[0]!.raw, 'binary'))).not.toThrow();
		expect(() => parseMessage('')).not.toThrow();
		const empty = parseMessage('');
		expect(empty.date).toBeUndefined();
		expect(empty.attachments).toEqual([]);
	});
});
