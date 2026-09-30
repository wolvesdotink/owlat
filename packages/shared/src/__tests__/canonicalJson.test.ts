import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson';

describe('canonicalJson', () => {
	it('sorts keys at every depth, so insertion order never counts', () => {
		const a = { b: 1, a: { d: [{ y: 1, x: 2 }], c: 'c' } };
		const b = { a: { c: 'c', d: [{ x: 2, y: 1 }] }, b: 1 };
		expect(canonicalJson(a)).toBe('{"a":{"c":"c","d":[{"x":2,"y":1}]},"b":1}');
		expect(canonicalJson(b)).toBe(canonicalJson(a));
	});

	it('orders integer-like keys as strings, by UTF-16 code unit', () => {
		expect(canonicalJson({ 10: 'ten', 2: 'two', a: 1, B: 2, é: 3, '': 4 })).toBe(
			'{"":4,"10":"ten","2":"two","B":2,"a":1,"é":3}'
		);
	});

	it('omits undefined members, including in nested optional objects', () => {
		const explicit = {
			event: 'sent',
			remoteMessageId: undefined,
			detail: { reason: undefined, code: 250 },
		};
		const absent = { event: 'sent', detail: { code: 250 } };
		expect(canonicalJson(explicit)).toBe('{"detail":{"code":250},"event":"sent"}');
		expect(canonicalJson(explicit)).toBe(canonicalJson(absent));
	});

	it('writes undefined, function and symbol array entries as null, keeping positions', () => {
		expect(canonicalJson([undefined, () => 1, Symbol('s'), 1])).toBe('[null,null,null,1]');
		const holey: unknown[] = [];
		holey[1] = 1;
		expect(canonicalJson(holey)).toBe('[null,1]');
	});

	it('omits function and symbol members like JSON.stringify', () => {
		expect(canonicalJson({ a: () => 1, b: Symbol('s'), c: 1 })).toBe('{"c":1}');
	});

	it('keeps null distinct from absence', () => {
		expect(canonicalJson({ a: null })).toBe('{"a":null}');
		expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
		expect(canonicalJson({ a: null })).not.toBe(canonicalJson({ a: undefined }));
	});

	it('writes non-finite numbers as null, as JSON.stringify does', () => {
		expect(canonicalJson({ a: Number.NaN, b: Infinity, c: -Infinity, d: -0 })).toBe(
			'{"a":null,"b":null,"c":null,"d":0}'
		);
	});

	it('honours toJSON', () => {
		const at = new Date(Date.UTC(2026, 0, 2));
		expect(canonicalJson({ at })).toBe('{"at":"2026-01-02T00:00:00.000Z"}');
	});

	it('escapes strings and keys exactly as JSON.stringify does', () => {
		const value = { 'k"\\\n': 'v"\\\n \ud800' };
		expect(canonicalJson(value)).toBe(JSON.stringify(value));
	});

	it('rejects what JSON.stringify rejects, and top-level values with no JSON text', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic['self'] = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(TypeError);
		expect(() => canonicalJson({ big: 1n })).toThrow(TypeError);
		expect(() => canonicalJson(undefined)).toThrow(TypeError);
		expect(() => canonicalJson(() => 1)).toThrow(TypeError);
	});

	it('allows the same object twice when it is not its own ancestor', () => {
		const shared = { x: 1 };
		expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"x":1},"b":[{"x":1}]}');
	});

	it('equals JSON.stringify up to key order, so it survives a JSON round trip', () => {
		const values: unknown[] = [
			{ b: [1, undefined, { d: undefined, c: null }], a: 'x', n: Number.NaN, t: true },
			[{ z: 1, y: { x: [] } }, 'é', -1.5e-7],
			'plain',
			42,
			null,
		];
		for (const value of values) {
			const persisted = JSON.stringify(value);
			const readBack: unknown = JSON.parse(persisted);
			expect(canonicalJson(readBack)).toBe(canonicalJson(value));
			expect(JSON.parse(canonicalJson(value))).toEqual(readBack);
		}
	});
});
