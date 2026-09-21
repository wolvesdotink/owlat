import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalize } from '../jcs.js';

/** Written with fromCharCode so the source file carries no raw control bytes. */
const ch = (code: number) => String.fromCharCode(code);

describe('RFC 8785 member ordering', () => {
	it('sorts members by UTF-16 code unit, not by insertion order', () => {
		expect(canonicalize({ b: 1, a: 2, C: 3, A: 4 })).toBe('{"A":4,"C":3,"a":2,"b":1}');
	});

	it('sorts a supplementary-plane key before a BMP key above U+D800', () => {
		// The discriminating case: by code POINT U+1D11E (G clef) is above
		// U+FB33, but its leading surrogate D834 is below it, and RFC 8785
		// §3.2.3 sorts by UTF-16 code units.
		const canonical = canonicalize({
			[String.fromCodePoint(0x1d11e)]: 'g-clef',
			[String.fromCodePoint(0xfb33)]: 'dalet',
		});
		expect(canonical.indexOf('g-clef')).toBeLessThan(canonical.indexOf('dalet'));
	});

	it('orders digits, capitals, lowercase and non-ASCII by code unit', () => {
		expect(Object.keys(JSON.parse(canonicalize({ é: 1, a: 2, A: 3, '€': 4, '1': 5 })))).toEqual([
			'1',
			'A',
			'a',
			'é',
			'€',
		]);
	});

	it('sorts nested objects and leaves array order alone', () => {
		expect(canonicalize({ z: [{ b: 1, a: 2 }, 3], a: { y: 1, x: 2 } })).toBe(
			'{"a":{"x":2,"y":1},"z":[{"a":2,"b":1},3]}'
		);
	});
});

describe('RFC 8785 number serialization', () => {
	it.each([
		[0, '0'],
		[-0, '0'],
		[1, '1'],
		[100.0, '100'],
		[-42.5, '-42.5'],
		[0.1, '0.1'],
		[1e21, '1e+21'],
		[1e-7, '1e-7'],
		[9007199254740992, '9007199254740992'],
		[5e-324, '5e-324'],
		[1.0000000000000002, '1.0000000000000002'],
		[1e-6, '0.000001'],
	])('serializes %p as %s', (value, expected) => {
		expect(canonicalize(value)).toBe(expected);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'refuses the non-finite number %p rather than emitting null',
		(value) => {
			expect(() => canonicalize(value)).toThrow(/non-finite/);
		}
	);
});

describe('RFC 8785 string serialization', () => {
	it('emits non-ASCII literally instead of escaping it', () => {
		expect(canonicalize({ s: 'héllo 🚀' })).toBe('{"s":"héllo 🚀"}');
	});

	it('uses the two-character escapes for backspace, tab, newline, form feed and return', () => {
		const controls = ch(0x08) + ch(0x09) + ch(0x0a) + ch(0x0c) + ch(0x0d);
		expect(canonicalize(controls)).toBe(String.raw`"\b\t\n\f\r"`);
	});

	it('escapes other control characters as lowercase-hex \\u sequences', () => {
		expect(canonicalize(ch(0x00) + ch(0x1f))).toBe(String.raw`"\u0000\u001f"`);
	});

	it('escapes quotes and backslashes, and nothing else', () => {
		expect(canonicalize('a"b\\c/d')).toBe(String.raw`"a\"b\\c/d"`);
	});

	it('escapes a lone surrogate rather than emitting invalid UTF-8', () => {
		expect(canonicalize(ch(0xd800))).toBe(String.raw`"\ud800"`);
	});

	it('sorts and escapes control characters used as member names', () => {
		expect(canonicalize({ [ch(0x0a)]: 1, a: 2 })).toBe(String.raw`{"\n":1,"a":2}`);
	});
});

describe('canonical form of the remaining JSON types', () => {
	it('serializes literals', () => {
		expect(canonicalize(null)).toBe('null');
		expect(canonicalize(true)).toBe('true');
		expect(canonicalize([])).toBe('[]');
		expect(canonicalize({})).toBe('{}');
	});

	it('omits undefined members and nulls undefined array holes, as JSON.stringify does', () => {
		expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
	});

	it('refuses values JSON has no representation for', () => {
		expect(() => canonicalize(() => 1)).toThrow(/function/);
		expect(() => canonicalize(10n)).toThrow(/bigint/);
	});

	it('ignores prototype toJSON methods — attestations are plain data', () => {
		class Wrapped {
			public a = 1;
			public toJSON(): string {
				return 'not-used';
			}
		}
		expect(canonicalize(new Wrapped())).toBe('{"a":1}');
	});

	it('serializes a Date as an empty object, which is why timestamps travel as strings', () => {
		expect(canonicalize(new Date(0))).toBe('{}');
	});
});

describe('canonicalBytes', () => {
	it('is the UTF-8 encoding of the canonical text', () => {
		const value = { s: 'héllo 🚀', n: 1e21 };
		expect(canonicalBytes(value).toString('utf8')).toBe(canonicalize(value));
		expect(canonicalBytes({ s: 'é' })).toHaveLength(Buffer.byteLength(canonicalize({ s: 'é' })));
	});

	it('is stable across member insertion order — the property signatures rest on', () => {
		expect(canonicalBytes({ a: 1, b: { c: 2, d: 3 } })).toEqual(
			canonicalBytes({ b: { d: 3, c: 2 }, a: 1 })
		);
	});
});
