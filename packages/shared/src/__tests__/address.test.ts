import { describe, it, expect } from 'vitest';
import { MAX_ADDRESS_HEADER_LENGTH } from '@owlat/mail-message/parse/address';
import {
	parseAddress,
	parseAddressList,
	extractDomain,
	extractDomainOrNull,
	type ParsedAddress,
} from '../address';

describe('parseAddress', () => {
	it('parses a bare email', () => {
		expect(parseAddress('me@hl.camp')).toEqual({ address: 'me@hl.camp' });
	});

	it('lowercases the address', () => {
		expect(parseAddress('Me@HL.Camp')).toEqual({ address: 'me@hl.camp' });
	});

	it('parses an angle-bracketed address with a name', () => {
		expect(parseAddress('Marcel <me@hl.camp>')).toEqual({ name: 'Marcel', address: 'me@hl.camp' });
	});

	it('strips surrounding quotes from the name', () => {
		expect(parseAddress('"Marcel Pfeifer" <me@hl.camp>')).toEqual({
			name: 'Marcel Pfeifer',
			address: 'me@hl.camp',
		});
	});

	it('returns null when no address can be parsed', () => {
		expect(parseAddress('no email here')).toBeNull();
		expect(parseAddress('')).toBeNull();
	});

	it('returns null for an angle-bracketed string without @', () => {
		expect(parseAddress('Bad <invalid>')).toBeNull();
	});
});

describe('parseAddressList', () => {
	it('parses a single address', () => {
		expect(parseAddressList('me@hl.camp')).toEqual([{ address: 'me@hl.camp' }]);
	});

	it('parses multiple comma-separated addresses', () => {
		expect(parseAddressList('a@x.com, b@y.com')).toEqual([
			{ address: 'a@x.com' },
			{ address: 'b@y.com' },
		]);
	});

	it('preserves comma inside quoted name', () => {
		expect(parseAddressList('"Smith, John" <john@x.com>, jane@y.com')).toEqual([
			{ name: 'Smith, John', address: 'john@x.com' },
			{ address: 'jane@y.com' },
		]);
	});

	it('handles addresses with display names and bare addresses mixed', () => {
		expect(parseAddressList('Alice <a@x.com>, b@y.com, "Bob" <c@z.com>')).toEqual([
			{ name: 'Alice', address: 'a@x.com' },
			{ address: 'b@y.com' },
			{ name: 'Bob', address: 'c@z.com' },
		]);
	});

	it('returns an empty list for empty input', () => {
		expect(parseAddressList('')).toEqual([]);
	});
});

describe('extractDomain', () => {
	it('extracts the domain from a bare address', () => {
		expect(extractDomain('me@hl.camp')).toBe('hl.camp');
	});

	it('extracts the domain from an angle-bracketed address', () => {
		expect(extractDomain('Marcel <me@hl.camp>')).toBe('hl.camp');
	});

	it('lowercases the domain', () => {
		expect(extractDomain('me@HL.CAMP')).toBe('hl.camp');
	});

	it('throws on invalid input', () => {
		expect(() => extractDomain('not an email')).toThrow(/Invalid email/);
		expect(() => extractDomain('')).toThrow(/Invalid email/);
	});
});

describe('extractDomainOrNull', () => {
	it('returns the domain on success', () => {
		expect(extractDomainOrNull('me@hl.camp')).toBe('hl.camp');
	});

	it('returns null on invalid input instead of throwing', () => {
		expect(extractDomainOrNull('not an email')).toBeNull();
		expect(extractDomainOrNull('')).toBeNull();
	});

	it('handles display-name wrapped addresses', () => {
		expect(extractDomainOrNull('"Marcel" <me@hl.camp>')).toBe('hl.camp');
	});
});

/**
 * Differential suite for the 2026-09 rewrite of `address.ts` into an adapter
 * over `@owlat/mail-message`'s parser.
 *
 * The pre-rewrite implementation is inlined below as the oracle. Copying ~35
 * lines of retired code into a test is the only way to assert the property
 * that matters — "the swap did not move any behaviour we did not mean to
 * move" — since the original is gone from the source tree. Every input the
 * two agree on lives in AGREE; every input they do NOT agree on is listed
 * individually under `deliberate divergences` with the reason, so a future
 * reader can tell a fix from a regression without re-deriving it.
 */
const legacyParseAddress = (input: string): ParsedAddress | null => {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const angle = trimmed.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
	if (angle && angle[1] !== undefined && angle[2] !== undefined) {
		const rawName = angle[1].trim().replace(/^"(.*)"$/, '$1');
		const address = angle[2].toLowerCase();
		if (!address.includes('@')) return null;
		return { name: rawName || undefined, address };
	}
	const bareMatch = trimmed.match(/([^\s<>]+@[^\s<>]+)/);
	if (!bareMatch || bareMatch[1] === undefined) return null;
	return { address: bareMatch[1].toLowerCase() };
};

const legacyParseAddressList = (value: string): ParsedAddress[] => {
	const out: ParsedAddress[] = [];
	let depth = 0;
	let inQuote = false;
	let buf = '';
	const flush = (): void => {
		const parsed = legacyParseAddress(buf);
		if (parsed) out.push(parsed);
		buf = '';
	};
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '"') inQuote = !inQuote;
		if (!inQuote && ch === '<') depth += 1;
		if (!inQuote && ch === '>') depth -= 1;
		if (ch === ',' && depth === 0 && !inQuote) {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return out;
};

/**
 * Everything the pre-rewrite tests covered, plus the malformed and
 * quoted-local-part shapes they did not. The adapter must be byte-identical
 * to the retired parser on all of them.
 */
const AGREE = [
	'me@hl.camp',
	'Me@HL.Camp',
	'Marcel <me@hl.camp>',
	'"Marcel Pfeifer" <me@hl.camp>',
	'no email here',
	'',
	'   ',
	'\t\r\n ',
	'Bad <invalid>',
	'a@x.com, b@y.com',
	'"Smith, John" <john@x.com>, jane@y.com',
	'Alice <a@x.com>, b@y.com, "Bob" <c@z.com>',
	// A single field whose display phrase carries an unquoted comma: `parseAddress`
	// must NOT read it as a list separator, which is why the adapter delegates to
	// the single-mailbox entry point rather than to `parseAddressList(x)[0]`.
	'Smith, John <j@x.com>',
	// Quoted local parts holding the two characters that drive the scanners.
	'"weird@local"@example.com',
	'"a,b"@example.com, c@d.com',
	'"Doe, John" <"j,d"@x.com>',
	// Angle-bracket nesting and unbalanced brackets.
	'A <<a@x.com>>',
	'<<a@x.com>',
	'Name <a@x.com',
	'a@x.com>',
	'<a@x.com>',
	'< a@x.com >',
	' \t me@hl.camp \t ',
	'a@x.com,,b@y.com',
	',',
	';',
];

describe('parser swap — agreement with the retired implementation', () => {
	it.each(AGREE)('parseAddress(%j) is unchanged', (input) => {
		expect(parseAddress(input)).toEqual(legacyParseAddress(input));
	});

	it.each(AGREE)('parseAddressList(%j) is unchanged', (input) => {
		expect(parseAddressList(input)).toEqual(legacyParseAddressList(input));
	});
});

describe('parser swap — deliberate divergences', () => {
	it('no longer mistakes a leading RFC 5322 comment for the address', () => {
		// The retired parser returned the comment itself: `{ address: '(a@b.com)' }`.
		expect(legacyParseAddress('(a@b.com) real@z.com')).toEqual({ address: '(a@b.com)' });
		expect(parseAddress('(a@b.com) real@z.com')).toEqual({
			name: 'a@b.com',
			address: 'real@z.com',
		});
	});

	it('uses a trailing comment as the display name when there is no phrase', () => {
		expect(parseAddress('real@z.com (Alice)')).toEqual({ name: 'Alice', address: 'real@z.com' });
	});

	it('keeps a comma inside a comment from splitting the list', () => {
		expect(parseAddressList('a@x.com (comment, with comma), b@y.com')).toEqual([
			{ name: 'comment, with comma', address: 'a@x.com' },
			{ address: 'b@y.com' },
		]);
	});

	it('drops a comment from an explicit display phrase (it is not part of the name)', () => {
		expect(parseAddress('Bob (the builder) <bob@x.com>')).toEqual({
			name: 'Bob',
			address: 'bob@x.com',
		});
	});

	it('flattens an RFC 5322 group to its members without the trailing semicolon', () => {
		// The retired parser leaked the group terminator into the last address:
		// `[{ address: 'alice@x.com' }, { address: 'bob@y.com;' }]`.
		expect(legacyParseAddressList('Friends: alice@x.com, bob@y.com;')[1]).toEqual({
			address: 'bob@y.com;',
		});
		expect(parseAddressList('Friends: alice@x.com, bob@y.com;')).toEqual([
			{ address: 'alice@x.com' },
			{ address: 'bob@y.com' },
		]);
	});

	it('mixes a bare mailbox and a group in one header', () => {
		expect(parseAddressList('root@x.com, Team: a@y.com;')).toEqual([
			{ address: 'root@x.com' },
			{ address: 'a@y.com' },
		]);
	});

	it('yields no recipients for an empty group', () => {
		expect(parseAddressList('Undisclosed recipients:;')).toEqual([]);
	});

	it('decodes an RFC 2047 encoded-word display name', () => {
		expect(parseAddress('=?utf-8?B?w6k=?= <e@x.com>')).toEqual({ name: 'é', address: 'e@x.com' });
	});
});

/**
 * The retired regex (`/^(.*?)<\s*([^>]+?)\s*>\s*$/`) backtracked
 * catastrophically on a `<`-run with no closing `>` and the module had no
 * input cap: measured 6.6 ms at 4 KB, 26 ms at 8 KB, 111 ms at 16 KB — clean
 * O(n^2), so a crafted header pinned a core for minutes. Every call site that
 * feeds this is reachable from an unauthenticated peer (IMAP APPEND headers,
 * the MTA's `/send` sealed-MIME `From:`, inbound routing), so the bound is the
 * point of the swap, not a nicety.
 */
describe('hostile input is bounded', () => {
	it('parses a 1 MB no-closing-> run in milliseconds and returns nothing', () => {
		const evil = 'A<'.repeat(500_000);
		const start = performance.now();
		const single = parseAddress(evil);
		const list = parseAddressList(evil);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
		expect(single).toBeNull();
		expect(list).toEqual([]);
	});

	it('truncates a header past the cap instead of throwing', () => {
		const padded = `${'x'.repeat(MAX_ADDRESS_HEADER_LENGTH)}, real@z.com`;
		expect(() => parseAddressList(padded)).not.toThrow();
		// Everything past the cap is dropped, so the trailing mailbox is gone.
		expect(parseAddressList(padded)).toEqual([]);
		// Under the cap the same shape parses normally.
		expect(parseAddressList(`${'x'.repeat(64)}, real@z.com`)).toEqual([{ address: 'real@z.com' }]);
	});
});

/**
 * `apps/imap`'s APPEND header extractor calls `parseAddressList` four times on
 * headers the connecting client supplies verbatim. This is the shape that path
 * sees: MIME-decoded upstream, folded, with a group and a quoted comma.
 */
describe('IMAP APPEND header shapes', () => {
	it('parses a folded To: header with a group and a quoted comma', () => {
		const header = '"Smith, John" <john@x.com>, Team: a@y.com, b@z.com;, c@w.com';
		expect(parseAddressList(header)).toEqual([
			{ name: 'Smith, John', address: 'john@x.com' },
			{ address: 'a@y.com' },
			{ address: 'b@z.com' },
			{ address: 'c@w.com' },
		]);
	});

	it("returns an empty list for an absent header (the `?? ''` default)", () => {
		expect(parseAddressList('')).toEqual([]);
	});
});
