/**
 * The single-pass MIME tree parser (`parse/body.ts`).
 *
 * 1. It builds exactly the tree the recursive definition gives, checked against
 *    the previous recursive splitter (`helpers/recursiveMimeReference.ts`) on the
 *    raw corpus, on mutated copies of it, and on generated trees that mix the
 *    edge cases: nested containers sharing a boundary, boundaries that are
 *    prefixes of each other, delimiters with trailing blanks, missing closing
 *    delimiters, preambles and epilogues holding delimiter-like lines, blank-line
 *    placement around header blocks, bare-LF line ends and the depth and part
 *    bounds.
 * 2. Its cost does not grow with nesting depth: a message nested to the depth
 *    bound parses about as fast as the same payload in a single part.
 */

import { describe, expect, it } from 'vitest';
import { MAX_MIME_PARTS, parseMimeTreeWithBounds, type MimeNode } from '../parse/body';
import { HOSTILE_FIXTURES, RAW_FIXTURES } from './fixtures/rawCorpus';
import { referenceMimeTree } from './helpers/recursiveMimeReference';

interface Projected {
	headers: Array<[string, string[]]>;
	type: string;
	params: Record<string, string>;
	multipart: boolean;
	rawBody: string;
	children: Projected[];
}

function project(node: MimeNode): Projected {
	const map = (node.headers as unknown as { map: Map<string, string[]> }).map;
	return {
		headers: [...map.entries()],
		type: node.contentType.value,
		params: node.contentType.params,
		multipart: node.isMultipart,
		rawBody: node.rawBody,
		children: node.children.map(project),
	};
}

function expectSameTree(raw: string, label: string, depth = 0, nested = false): void {
	const actual = parseMimeTreeWithBounds(raw, depth, nested);
	const expected = referenceMimeTree(raw, depth, nested);
	expect(actual.truncated, `${label}: truncated`).toBe(expected.truncated);
	expect(project(actual.root), label).toEqual(project(expected.root));
}

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

const BOUNDARIES = ['a', 'a--', 'a-', 'b', 'bb', 'x y', '=_q', 'a b'];

/** A random message tree that leans on the splitter's edge cases. */
function generate(rng: () => number, depth: number, maxDepth: number): string {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
	const nl = rng() < 0.85 ? '\r\n' : '\n';
	const blanks = () => pick(['', '', '', ' ', '\t', ' \t ']);
	const noise = () =>
		pick([
			'text',
			'',
			`--${pick(BOUNDARIES)}`,
			`--${pick(BOUNDARIES)}--`,
			`--${pick(BOUNDARIES)}x`,
			'-- ',
			'Content-Type: text/html',
		]);
	const lines = (count: number) => Array.from({ length: count }, noise).join(nl);

	// Header block: usually a blank line after it, sometimes none, sometimes a
	// leading blank line or two.
	const headerLead = pick(['', '', '', nl, nl + nl]);
	if (depth < maxDepth && rng() < 0.65) {
		const boundary = pick(BOUNDARIES);
		const quoted = rng() < 0.7 ? `"${boundary}"` : boundary;
		const header = pick([
			`Content-Type: multipart/mixed; boundary=${quoted}`,
			`Content-Type: multipart/alternative boundary=${quoted}`,
			`Content-Type: multipart/related;${nl} boundary=${quoted}`,
		]);
		let out = `${headerLead}${header}${nl}${rng() < 0.9 ? nl : ''}`;
		if (rng() < 0.4) out += lines(Math.floor(rng() * 3)) + nl;
		const parts = Math.floor(rng() * 4);
		for (let i = 0; i < parts; i++) {
			out += `--${boundary}${blanks()}${nl}`;
			out += generate(rng, depth + 1, maxDepth);
			out += nl;
		}
		const ending = rng();
		if (ending < 0.7) out += `--${boundary}--${blanks()}`;
		if (ending < 0.4) out += nl + lines(Math.floor(rng() * 3));
		if (rng() < 0.3) out += nl;
		return out;
	}
	const body = lines(Math.floor(rng() * 4));
	return `${headerLead}Content-Type: text/plain${nl}${rng() < 0.85 ? nl : ''}${body}`;
}

/** Apply one random mutation (truncate / flip / inject / duplicate) to `input`. */
function mutate(input: string, rng: () => number): string {
	if (input.length === 0) return input;
	const at = Math.floor(rng() * input.length);
	switch (Math.floor(rng() * 4)) {
		case 0:
			return input.slice(0, at);
		case 1:
			return (
				input.slice(0, at) + String.fromCharCode(Math.floor(rng() * 256)) + input.slice(at + 1)
			);
		case 2:
			return `${input.slice(0, at)}\r\n--${BOUNDARIES[at % BOUNDARIES.length]}\r\n${input.slice(at)}`;
		default: {
			const end = Math.min(input.length, at + Math.floor(rng() * 200));
			return input.slice(0, end) + input.slice(at, end) + input.slice(end);
		}
	}
}

describe('single-pass MIME tree matches the recursive definition', () => {
	it('on the raw corpus', () => {
		for (const fixture of [...RAW_FIXTURES, ...HOSTILE_FIXTURES]) {
			expectSameTree(fixture.raw, fixture.name);
			expectSameTree(fixture.raw, `${fixture.name} (nested)`, 3, true);
		}
	});

	it('on mutated copies of the corpus', () => {
		const rng = makeRng(0x5eed);
		const corpus = [...RAW_FIXTURES, ...HOSTILE_FIXTURES];
		for (let i = 0; i < 3000; i++) {
			let raw = corpus[i % corpus.length]!.raw;
			const rounds = 1 + Math.floor(rng() * 3);
			for (let r = 0; r < rounds; r++) raw = mutate(raw, rng);
			expectSameTree(raw, `mutation ${i}`);
		}
	});

	it('on generated trees built from the edge cases', () => {
		const rng = makeRng(0xb0da);
		for (let i = 0; i < 3000; i++) {
			const raw = generate(rng, 0, 1 + Math.floor(rng() * 5));
			expectSameTree(raw, `generated ${i}: ${JSON.stringify(raw)}`);
		}
	});

	it('at the depth bound', () => {
		for (const levels of [99, 100, 101, 120]) {
			let raw = 'Content-Type: text/plain\r\n\r\ninnermost\r\n';
			for (let i = levels - 1; i >= 0; i--) {
				raw = `Content-Type: multipart/mixed; boundary="d${i}"\r\n\r\n--d${i}\r\n${raw}\r\n--d${i}--\r\n`;
			}
			expectSameTree(raw, `${levels} levels`);
		}
	});

	it('at the part bound', () => {
		for (const count of [MAX_MIME_PARTS - 1, MAX_MIME_PARTS, MAX_MIME_PARTS + 1]) {
			const flat = Array.from({ length: count }, (_, i) => `--f\r\n\r\npart ${i}\r\n`).join('');
			expectSameTree(
				`Content-Type: multipart/mixed; boundary="f"\r\n\r\n${flat}--f--\r\n`,
				`${count} parts`
			);
			// The same parts split across two sibling containers.
			const half = Math.floor(count / 2);
			const inner = (from: number, to: number) =>
				`Content-Type: multipart/mixed; boundary="g"\r\n\r\n${Array.from(
					{ length: to - from },
					(_, i) => `--g\r\n\r\npart ${from + i}\r\n`
				).join('')}--g--`;
			expectSameTree(
				`Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\n${inner(0, half)}\r\n--o\r\n${inner(half, count)}\r\n--o--\r\n`,
				`${count} parts in two containers`
			);
		}
	});
});

describe('nested MIME parse cost', () => {
	/** A message whose one text part sits under `levels` nested containers. */
	function nestedMessage(levels: number, payload: string): string {
		let head = '';
		let tail = '';
		for (let i = 0; i < levels; i++) {
			head += `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n`;
			tail = `\r\n--n${i}--\r\n${tail}`;
		}
		return `${head}Content-Type: text/plain\r\n\r\n${payload}${tail}`;
	}

	const timed = (fn: () => unknown): number => {
		const start = performance.now();
		fn();
		return performance.now() - start;
	};

	it('does not grow with nesting depth', () => {
		// 4 MiB of blank lines: the line-heavy shape each nesting level used to
		// rescan. The previous splitter took roughly depth times the flat time.
		const payload = '\r\n'.repeat(2 * 1024 * 1024);
		const flat = nestedMessage(1, payload);
		const deep = nestedMessage(100, payload);

		const flatMs = Math.min(
			timed(() => parseMimeTreeWithBounds(flat)),
			timed(() => parseMimeTreeWithBounds(flat))
		);
		const deepMs = Math.min(
			timed(() => parseMimeTreeWithBounds(deep)),
			timed(() => parseMimeTreeWithBounds(deep))
		);

		// Relative to the flat parse on the same machine, so a loaded CI host
		// slows both sides alike; the old splitter was ~20x slower here.
		expect(deepMs).toBeLessThan(flatMs * 4 + 250);
		expect(parseMimeTreeWithBounds(deep).truncated).toBe(false);
	});
});
